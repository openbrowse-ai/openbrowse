/**
 * SW agent-host: orchestrate one agent run.
 *
 * `startRun` wires the registry, transport, persistence, and snapshot
 * broadcast together for a single conversation, then drives the stream
 * to terminal state. It returns a `RunControl` whose `completion`
 * promise resolves when the run terminates (success, error, or abort).
 *
 * The stream is `.tee()`'d into two reader pipelines:
 *
 *   1. **Chunk fan-out** — every `UIMessageChunk` is wrapped in an
 *      `AGENT_RUN_CHUNK` payload and posted to every connected
 *      subscriber port in `handle.subscribers`. Disconnected ports
 *      (postMessage throws) are silently skipped; if the entire
 *      subscriber set empties the run still continues, because the
 *      persistence + snapshot pipelines remain.
 *
 *   2. **Message-aware pipeline** — the cloned stream is fed through
 *      `readUIMessageStream` to surface the rolling assistant messages.
 *      Each message goes to both:
 *        - the chat-db persister (upsert by id, skips empty turns), and
 *        - the snapshot broadcaster, so renderer surfaces that missed
 *          a live chunk (because they were frozen/late) can catch up
 *          via the throttled `STREAM_PARTS` channel.
 *
 * On terminal state:
 *   - subscribers receive `AGENT_RUN_DONE` (or `AGENT_RUN_ERROR` on
 *     transport failure);
 *   - `snapshotBroadcaster.done()` flushes any pending trailing snapshot
 *     and emits `STREAM_DONE`;
 *   - the handle is released from the registry.
 *
 * Approval handling is intentionally NOT modeled here. The AI SDK
 * `Chat`/`useChat` instance in the renderer manages tool-approval state;
 * approval applies to the renderer-side message list and triggers a
 * follow-up `sendMessage` call (`sendAutomaticallyWhen` in
 * `useAgentChat.ts:462`), which opens a fresh `agent-run` for the same
 * `conversationId` *after* this run has terminated. The registry's
 * one-run-per-conversation invariant therefore holds — sequential runs,
 * not concurrent.
 *
 * SW lifecycle / orphan recovery:
 *   The `RunHandle` is in-memory only — an MV3 SW restart (memory
 *   pressure, browser update) drops it. The chat-db has whatever the
 *   persister wrote up to the last step boundary, including any
 *   in-flight assistant message with `tool-call` parts in `pending`
 *   state. When a renderer reopens the conversation, its existing
 *   `healPendingTools` pass (`@/lib/agent/heal-pending-tools`,
 *   invoked from `useAgentChat`) rewrites those pending parts to
 *   `output-error` with TOOL_HEAL_INTERRUPT_TEXT. From the user's
 *   perspective the conversation shows the partial assistant message
 *   ending in an errored tool call and a Regenerate affordance — same
 *   as the legacy renderer-host SW-death recovery. No new SW-side
 *   recovery code is needed for top-level runs; the heal-on-open path
 *   covers them transparently.
 */

import { readUIMessageStream, type UIMessageChunk } from "ai";
import type { AgentUIMessage } from "@/lib/agent/message-types";
import {
  AGENT_RUN,
  type AgentRunChunkPayload,
  type AgentRunDonePayload,
  type AgentRunErrorPayload,
  type RunOrigin,
} from "./messages";
import type { AgentHostRegistry, RunHandle } from "./registry";
import type { AssistantStreamPersister } from "./persist-stream";
import type { SnapshotBroadcaster } from "./snapshot-broadcast";
import { serializeParts } from "@/lib/agent/serialize-parts";

export interface StartRunArgs {
  conversationId: string;
  messages: AgentUIMessage[];
  origin: RunOrigin;
}

/**
 * Minimal transport shape consumed by `startRun`. Production uses
 * `CompactingChatTransport` built via `createAgentTransport`; tests
 * pass a fake whose `sendMessages` resolves to a `ReadableStream`.
 */
export interface RunTransport {
  sendMessages(args: {
    messages: AgentUIMessage[];
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<UIMessageChunk>>;
}

export interface StartRunDeps {
  registry: AgentHostRegistry;
  buildTransport(args: StartRunArgs, handle: RunHandle): RunTransport;
  buildPersister(args: StartRunArgs, handle: RunHandle): AssistantStreamPersister;
  buildSnapshotBroadcaster(
    args: StartRunArgs,
    handle: RunHandle,
  ): SnapshotBroadcaster;
}

export interface RunControl {
  handle: RunHandle;
  /** Resolves when the run reaches a terminal state (success, error, abort). */
  completion: Promise<void>;
}

function postToSubscriber(
  port: chrome.runtime.Port,
  payload: AgentRunChunkPayload | AgentRunDonePayload | AgentRunErrorPayload,
  onError: (port: chrome.runtime.Port) => void,
): void {
  try {
    port.postMessage(payload);
  } catch {
    // Port disconnected between membership-check and post; remove it.
    onError(port);
  }
}

/**
 * Drive a single agent run end-to-end.
 *
 * Throws synchronously if the conversation already has a live handle in
 * the registry (caller is responsible for ensuring the prior run was
 * released, e.g. by awaiting the prior `completion`).
 */
export function startRun(args: StartRunArgs, deps: StartRunDeps): RunControl {
  const { conversationId } = args;

  const handle: RunHandle = {
    conversationId,
    abort: new AbortController(),
    startedAt: Date.now(),
    status: "running",
    subscribers: new Set(),
  };
  deps.registry.register(handle);

  // Construct the run's dependencies. A synchronous throw here (e.g. a
  // misconfigured `buildPersister` factory rejects on bad args) would
  // otherwise leave the handle registered as "running" with no
  // `completion` IIFE to clean it up — the conversation would be wedged
  // until the SW restarts. Catch + release + rethrow so the caller
  // sees the error and the registry stays consistent.
  let transport: RunTransport;
  let persister: AssistantStreamPersister;
  let snapshot: SnapshotBroadcaster;
  try {
    transport = deps.buildTransport(args, handle);
    persister = deps.buildPersister(args, handle);
    snapshot = deps.buildSnapshotBroadcaster(args, handle);
  } catch (err) {
    deps.registry.release(conversationId);
    throw err;
  }

  const completion = (async () => {
    let chunkStream: ReadableStream<UIMessageChunk>;
    try {
      chunkStream = await transport.sendMessages({
        messages: args.messages,
        abortSignal: handle.abort.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitError(handle, message);
      handle.status = "errored";
      // Best-effort: broadcasting the trailing snapshot is non-essential
      // for run correctness. If `done()` throws (e.g. a cross-realm
      // sendMessage failure surfaces synchronously here), swallow so the
      // cleanup below — including `deps.registry.release` — is
      // guaranteed. Without this guard a thrown `done()` would propagate
      // out of the IIFE, skip `registry.release`, and leak the handle
      // until SW restart.
      try {
        snapshot.done();
      } catch {
        // ignore
      }
      // Best-effort indicator teardown even on the early-exit path.
      // `resetAgentIndicator` is a no-op when `agentActive` was never
      // set true (i.e. the transport blew up before any tool ran), but
      // a fast-fail transient (e.g. an LLM 4xx) can still leave the
      // working state dirty in pathological cases — clear it. Pass the
      // cid so the per-tab teardown only touches THIS run's overlays,
      // leaving peer parallel runs untouched.
      try {
        const { resetAgentIndicator } = await import(
          "@/lib/agent/agent-transport"
        );
        resetAgentIndicator(conversationId);
      } catch {
        // ignore
      }
      deps.registry.release(conversationId);
      return;
    }

    // Tee: branch A = raw chunk fan-out to subscribers; branch B = parsed
    // assistant messages for persistence + snapshot broadcast.
    const [fanoutStream, messageStream] = chunkStream.tee();

    const fanoutPromise = pumpFanout(fanoutStream, handle);
    const messagePromise = pumpMessages(
      messageStream,
      persister,
      snapshot,
      handle,
    );

    let errMessage: string | null = null;
    try {
      await Promise.all([fanoutPromise, messagePromise]);
    } catch (err) {
      errMessage = err instanceof Error ? err.message : String(err);
    }

    // Heal any stranded tool parts in the last assistant message in
    // chat-db. Required on EVERY termination path (success, abort,
    // error, disconnect) because the persister writes the in-flight
    // assistant message incrementally and may leave non-terminal tool
    // states (e.g. `input-streaming`) when the run terminates mid-tool.
    //
    // CRITICAL TIMING: This MUST run BEFORE `emitDone` / `emitError`
    // (which flip `handle.status` and notify subscribers). If we notify
    // subscribers first, the queue watcher in the renderer can immediately
    // start a NEW run, which writes a NEW assistant message to chatDb.
    // This heal pass would then mistakenly mutate the NEW run's tool
    // calls into "Interrupted" state, causing visual flashing in the UI.
    try {
      const { healLastAssistantInChatDb } = await import("./heal-chatdb");
      await healLastAssistantInChatDb(conversationId);
    } catch {
      // Heal failed — log and continue. The renderer-side heal will
      // still run on the next user action.
    }

    try {
      if (errMessage != null) {
        handle.status = handle.abort.signal.aborted ? "aborted" : "errored";
        emitError(handle, errMessage);
      } else {
        handle.status = "completed";
        emitDone(handle);
      }
    } finally {
      // Best-effort: see the matching guard on the early-exit path
      // above. `snapshot.done()` is non-essential for run correctness;
      // a throw here must NOT block the subsequent ownership check +
      // `resetAgentIndicator` + `registry.release` — those steps are
      // required to release the handle so the queue watcher can start
      // the next turn.
      try {
        snapshot.done();
      } catch {
        // ignore
      }

      // If a new run has already claimed this conversation (because the
      // queue watcher immediately started the next turn before our
      // teardown finished), DO NOT tear down the indicator or release
      // the registry handle. The new run owns them now.
      const currentHandle = deps.registry.get(conversationId);
      if (currentHandle !== handle) return;

      // Tear down the per-run "agent is working" indicator + worked-tab
      // debugger sessions. Under SW-host the agent loop ran in THIS
      // realm, so `agentActive` and `cdp-session`'s session map live
      // here; the renderer's `useChat.onFinish` cannot clean them up
      // because its module-scope copies of those globals are different
      // instances. Calling it here closes the overlay/toast/CSS that
      // `notifyAgentStatus(true)` injected via the tool wrapper, and
      // detaches `chrome.debugger` from every worked tab (parity with
      // the pre-SW-host renderer-side call).
      try {
        const { resetAgentIndicator } = await import(
          "@/lib/agent/agent-transport"
        );
        resetAgentIndicator(conversationId);
      } catch {
        // Best-effort: the run already finished; leaving the indicator
        // up is annoying but not blocking.
      }
      deps.registry.release(conversationId);
    }
  })();

  return { handle, completion };
}

async function pumpFanout(
  stream: ReadableStream<UIMessageChunk>,
  handle: RunHandle,
): Promise<void> {
  const reader = stream.getReader();
  // Wire the abort signal so a `stopRun` mid-pump unwinds even if the
  // transport doesn't honor the signal at the stream level. Cancelling
  // the reader causes the next `read()` to resolve with `done: true`.
  const onAbort = () => {
    reader.cancel(new Error("run aborted")).catch(() => {});
  };
  if (handle.abort.signal.aborted) onAbort();
  else handle.abort.signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      const payload: AgentRunChunkPayload = {
        type: AGENT_RUN.CHUNK,
        conversationId: handle.conversationId,
        chunk: value,
      };
      // Snapshot the subscribers at this moment; mid-iteration deletes
      // from `handle.subscribers.delete` should take effect on the next
      // chunk, not interrupt this one.
      const subs = Array.from(handle.subscribers);
      for (const port of subs) {
        if (!handle.subscribers.has(port)) continue;
        postToSubscriber(port, payload, (p) => handle.subscribers.delete(p));
      }
    }
  } finally {
    handle.abort.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function pumpMessages(
  stream: ReadableStream<UIMessageChunk>,
  persister: AssistantStreamPersister,
  snapshot: SnapshotBroadcaster,
  handle: RunHandle,
): Promise<void> {
  // Mirror pumpFanout's abort-cancels-reader behavior. `readUIMessageStream`
  // consumes the source stream internally, so cancelling that source
  // unwinds the AsyncIterable cleanly with no further messages.
  const cancellable = (() => {
    const reader = stream.getReader();
    const onAbort = () => {
      reader.cancel(new Error("run aborted")).catch(() => {});
    };
    if (handle.abort.signal.aborted) onAbort();
    else handle.abort.signal.addEventListener("abort", onAbort, { once: true });
    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  })();

  const uiStream = readUIMessageStream<AgentUIMessage>({ stream: cancellable });
  for await (const message of uiStream) {
    if (handle.abort.signal.aborted) break;
    if (message.role !== "assistant") continue;
    // Persist incrementally (upsert by id; empty-turn skip inside).
    await persister.persist(message);
    // Push the rolling snapshot through the throttled display channel.
    snapshot.emit({
      messageId: message.id,
      parts: serializeParts(message.parts),
    });
  }
}

function emitDone(handle: RunHandle): void {
  const payload: AgentRunDonePayload = {
    type: AGENT_RUN.DONE,
    conversationId: handle.conversationId,
  };
  for (const port of Array.from(handle.subscribers)) {
    postToSubscriber(port, payload, (p) => handle.subscribers.delete(p));
  }
}

function emitError(handle: RunHandle, message: string): void {
  const payload: AgentRunErrorPayload = {
    type: AGENT_RUN.ERROR,
    conversationId: handle.conversationId,
    message,
  };
  for (const port of Array.from(handle.subscribers)) {
    postToSubscriber(port, payload, (p) => handle.subscribers.delete(p));
  }
}

/**
 * Abort the live run for `conversationId`. No-op if no live run exists.
 *
 * The abort propagates through the transport's `AbortSignal` (passed into
 * `sendMessages` above). The transport / underlying `agent.stream()` is
 * expected to honor the signal — terminating its `ReadableStream`, which
 * unwinds both fan-out and message pipelines via the iterator's `done`
 * branch. The `completion` promise then resolves, the handle is released,
 * and subscribers receive a final `AGENT_RUN_DONE` (or `_ERROR` if the
 * transport surfaced the abort as a thrown error).
 */
export function stopRun(
  registry: AgentHostRegistry,
  conversationId: string,
): void {
  const handle = registry.get(conversationId);
  if (handle == null) return;
  handle.abort.abort();
}
