/**
 * Renderer-side `ChatTransport` that proxies the AI SDK `Chat` /
 * `useChat` to the SW agent host over an `agent-run:<conversationId>`
 * Port.
 *
 * This is the thin shim that replaces the renderer-hosted
 * `CompactingChatTransport`: instead of constructing the `ToolLoopAgent`
 * locally and consuming its stream in-process (which freezes when the
 * tab is backgrounded), the renderer hands the messages to the SW and
 * reads back chunks over a Port.
 *
 * Wire protocol — see `entrypoints/background/agent-host/messages.ts`.
 *
 * Behavior:
 *   - `sendMessages` opens a fresh port, sends AGENT_RUN_START, and
 *     returns a `ReadableStream<UIMessageChunk>` that yields whatever
 *     `AGENT_RUN_CHUNK` messages the SW posts back. AGENT_RUN_DONE
 *     closes the stream cleanly; AGENT_RUN_ERROR errors it. Port
 *     disconnection while the stream is open also errors it.
 *   - `abortSignal` aborts: post AGENT_RUN_STOP and disconnect the
 *     port so the SW removes the subscriber slot. The SW's `stopRun`
 *     handles aborting the underlying transport.
 *   - `reconnectToStream` opens a fresh port and inspects the
 *     AGENT_RUN_ACK. If `hasActiveRun: true`, the port becomes the
 *     subscriber and the returned stream is wired to its chunks.
 *     If `hasActiveRun: false`, the port is disconnected and the
 *     promise resolves to `null` per the `ChatTransport` contract.
 */

import type { ChatTransport, UIMessageChunk } from "ai";
import type { AgentUIMessage } from "@/lib/agent/message-types";
import {
  AGENT_RUN,
  AGENT_RUN_PORT_PREFIX,
  isAgentRunAckPayload,
  isAgentRunChunkPayload,
  isAgentRunDonePayload,
  isAgentRunErrorPayload,
  type RunOrigin,
} from "@/entrypoints/background/agent-host/messages";

/**
 * Settings the renderer is responsible for snapshotting onto each
 * AGENT_RUN_START. The SW reads global storage settings itself; this
 * shape covers what's per-conversation only.
 */
export interface RemoteTransportSettingsSnapshot {
  agentModel: string;
  spaceId: string | null;
  thinkingEnabled?: boolean;
  thinkingConfig?: unknown;
  headless?: { autoApprove: boolean };
}

export class RemoteChatTransport implements ChatTransport<AgentUIMessage> {
  constructor(
    private readonly conversationId: string,
    private readonly settingsSnapshot: RemoteTransportSettingsSnapshot,
    private readonly origin: RunOrigin = "sidepanel",
  ) {}

  async sendMessages(options: {
    trigger: "submit-message" | "regenerate-message";
    chatId: string;
    messageId: string | undefined;
    messages: AgentUIMessage[];
    abortSignal: AbortSignal | undefined;
  }): Promise<ReadableStream<UIMessageChunk>> {
    const port = chrome.runtime.connect({
      name: `${AGENT_RUN_PORT_PREFIX}${this.conversationId}`,
    });

    const { stream, abortStream } = makeChunkStream(port);

    port.postMessage({
      type: AGENT_RUN.START,
      conversationId: this.conversationId,
      messages: options.messages,
      origin: this.origin,
      settingsSnapshot: this.settingsSnapshot,
    });

    if (options.abortSignal != null) {
      wireAbort(options.abortSignal, port, this.conversationId, abortStream);
    }

    return stream;
  }

  async reconnectToStream(_options: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    return new Promise((resolve) => {
      const port = chrome.runtime.connect({
        name: `${AGENT_RUN_PORT_PREFIX}${this.conversationId}`,
      });
      let settled = false;
      // Bounded ACK timeout — the port should ACK within microseconds
      // of accepting onConnect (port-router.handleConnect posts ACK as
      // its first action). A missing ACK implies SW pathology
      // (handler died, port-router never registered, etc.). Without
      // this guard the promise would hang forever and the renderer
      // would stay wedged. 5s matches `probeAgentRunAwaitIdle`'s
      // budget for the analogous probe path.
      const ACK_TIMEOUT_MS = 5_000;
      let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(
        () => {
          timeoutId = null;
          try {
            port.disconnect();
          } catch {
            // ignore
          }
          safeResolve(null);
        },
        ACK_TIMEOUT_MS,
      );

      const clearAckTimeout = (): void => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const safeResolve = (
        value: ReadableStream<UIMessageChunk> | null,
      ) => {
        if (settled) return;
        settled = true;
        clearAckTimeout();
        resolve(value);
      };

      // Wait for the ACK; if a run is live, build the stream from this
      // same port and resolve with it. Otherwise disconnect + resolve null.
      const ackListener = (msg: unknown) => {
        if (!isAgentRunAckPayload(msg)) return;
        port.onMessage.removeListener?.(ackListener as never);
        if (msg.hasActiveRun) {
          // Build a stream over this port. The chunk-pump's listener
          // is added inside `makeChunkStream` — but we already consumed
          // the ACK above, so build the stream now and any subsequent
          // CHUNK messages flow through.
          safeResolve(makeChunkStream(port).stream);
        } else {
          try {
            port.disconnect();
          } catch {
            // ignore
          }
          safeResolve(null);
        }
      };
      port.onMessage.addListener(ackListener);
      port.onDisconnect.addListener(() => {
        safeResolve(null);
      });
    });
  }
}

/**
 * Construct a `ReadableStream<UIMessageChunk>` whose controller is
 * driven by `port.onMessage`. The controller closes on AGENT_RUN_DONE
 * and errors on AGENT_RUN_ERROR or port disconnect.
 *
 * Returns `{ stream, abortStream }`. The caller can invoke
 * `abortStream()` to error the controller directly — this is required
 * for the renderer-initiated abort path, because per Chrome docs
 * calling `port.disconnect()` locally does NOT fire the local
 * `onDisconnect` listener (the event fires only on the peer end). So
 * the abort path can't rely on disconnect to wake up the SDK's
 * `consumeStream` reader — it has to error the controller explicitly.
 *
 * Note: this attaches its own onMessage listener. If the caller is
 * `reconnectToStream` and has already consumed the ACK, that's fine —
 * `isAgentRunAckPayload` chunks here just no-op.
 */
function makeChunkStream(
  port: chrome.runtime.Port,
): {
  stream: ReadableStream<UIMessageChunk>;
  abortStream: (reason?: string) => void;
} {
  let externalAbort: ((reason?: string) => void) | null = null;
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      let closed = false;

      const closeWithError = (msg: string) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(new Error(msg));
        } catch {
          // ignore
        }
      };

      externalAbort = (reason?: string) => {
        closeWithError(reason ?? "Aborted by user");
      };

      const onMessage = (msg: unknown) => {
        if (closed) return;
        if (isAgentRunChunkPayload(msg)) {
          try {
            controller.enqueue(msg.chunk);
          } catch {
            // Controller already closed; ignore.
          }
          return;
        }
        if (isAgentRunDonePayload(msg)) {
          closed = true;
          try {
            controller.close();
          } catch {
            // ignore
          }
          // Release the port now that the stream is complete. Without
          // this each send leaks one open Port (the SW emits DONE but
          // doesn't close its side, so the port stays half-open). Many
          // turns would accumulate many idle ports.
          try {
            port.disconnect();
          } catch {
            // ignore
          }
          return;
        }
        if (isAgentRunErrorPayload(msg)) {
          closeWithError(msg.message);
          try {
            port.disconnect();
          } catch {
            // ignore
          }
          return;
        }
        // ACK and unknown messages are intentionally ignored here.
      };

      const onDisconnect = () => {
        // Only fires when the PEER (SW) disconnects — see Chrome docs.
        // Local `port.disconnect()` won't trigger this, which is why
        // the abort path also uses `externalAbort` to close the
        // controller directly.
        closeWithError("SW agent-run port disconnected");
      };

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    },
    cancel(_reason) {
      try {
        port.disconnect();
      } catch {
        // ignore
      }
    },
  });
  return {
    stream,
    abortStream: (reason) => externalAbort?.(reason),
  };
}

function wireAbort(
  signal: AbortSignal,
  port: chrome.runtime.Port,
  conversationId: string,
  abortStream: (reason?: string) => void,
): void {
  const onAbort = () => {
    // Order matters here. Error the local stream FIRST so the AI SDK
    // consumer wakes up and transitions out of `streaming` — without
    // this the SDK hangs on `consumeStream` forever (per
    // remote-transport.test.ts regression test).
    abortStream("Aborted by user");
    try {
      port.postMessage({
        type: AGENT_RUN.STOP,
        conversationId,
      });
    } catch {
      // Port may already be gone.
    }
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  };
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
}

/**
 * One-shot probe: opens a transient `agent-run:<cid>` port, reads the
 * AGENT_RUN_ACK, and resolves with the `hasActiveRun` flag. The port
 * is always disconnected on resolution.
 *
 * Used by the renderer's submit path as a final pre-flight check to
 * avoid opening a duplicate AGENT_RUN_START on a conversation that
 * already has an active run on the SW. Per the port-router contract
 * (`port-router.ts:96-106`), a duplicate START is silently folded into
 * a viewer-attach — the new message payload is dropped. If the
 * renderer's local `useChat.status` and `isAgentActiveGlobally` are
 * both stale (e.g. after the initiator watchdog flipped status to
 * `ready` but the SW run is still going), the renderer can think the
 * chat is idle and submit anyway, causing the message to vanish. The
 * probe catches this state by asking the SW directly.
 *
 * Resolves `false` if the ACK doesn't arrive within `timeoutMs` (default
 * 250ms — keep this small; this is on the submit hot path) or if the
 * port disconnects before any ACK. False is the conservative answer:
 * if we don't know, assume no active run and let the submit proceed.
 */
export function probeAgentRun(
  conversationId: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 250;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let port: chrome.runtime.Port | null = null;

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
      resolve(value);
    };

    try {
      port = chrome.runtime.connect({
        name: `${AGENT_RUN_PORT_PREFIX}${conversationId}`,
      });
    } catch {
      resolve(false);
      return;
    }

    port.onMessage.addListener((msg: unknown) => {
      if (isAgentRunAckPayload(msg)) {
        finish(msg.hasActiveRun);
      }
      // Any other message types are ignored here — we don't subscribe
      // to chunks. The disconnect in `finish` tears the port down.
    });
    port.onDisconnect.addListener(() => {
      // SW disconnected before sending ACK — treat as "no active run"
      // so the submit can proceed (best-effort, fail-open).
      finish(false);
    });

    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

/**
 * Like `probeAgentRun`, but when the SW reports an active run, KEEPS
 * the port open and waits for the run to terminate — either via
 * AGENT_RUN_DONE / AGENT_RUN_ERROR on the port (the SW emits these to
 * subscribers when the run reaches a terminal state) or by port
 * disconnect (peer-side, e.g. SW eviction).
 *
 * Resolves `true` only if the SW currently has an active run AND it
 * stays active for the full `waitMs` window without terminating (the
 * caller should treat this as "still running, try later"). Resolves
 * `false` if there's no active run, OR if a run was active but
 * terminated within `waitMs`.
 *
 * Why this exists separately from `probeAgentRun`: the auto-flush
 * watcher needs to drain the queue as soon as the SW becomes idle,
 * but the SW's run-termination sequence (in `run.ts`'s finally block)
 * runs the chatDb heal, broadcasts STREAM_DONE, AND releases the
 * registry handle in that order. A bare `probeAgentRun` fired right
 * after the renderer's local `status` transitions to `ready` (from
 * the port-side AGENT_RUN_DONE) races the SW's finally and sees the
 * handle still registered → returns true → effect early-returns →
 * queue stays stuck because no further dep change re-triggers the
 * effect. By holding the port open and waiting for the actual
 * termination event before resolving, this version closes the race.
 *
 * `waitMs` caps the wait so a long-running run doesn't pin this
 * promise forever. Set to ~2× the longest expected post-stop tail.
 */
export function probeAgentRunAwaitIdle(
  conversationId: string,
  opts: { ackTimeoutMs?: number; waitMs?: number } = {},
): Promise<boolean> {
  const ackTimeoutMs = opts.ackTimeoutMs ?? 250;
  const waitMs = opts.waitMs ?? 5_000;
  return new Promise((resolve) => {
    let settled = false;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    let port: chrome.runtime.Port | null = null;

    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (ackTimer != null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      if (waitTimer != null) {
        clearTimeout(waitTimer);
        waitTimer = null;
      }
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
      resolve(value);
    };

    try {
      port = chrome.runtime.connect({
        name: `${AGENT_RUN_PORT_PREFIX}${conversationId}`,
      });
    } catch {
      resolve(false);
      return;
    }

    port.onMessage.addListener((msg: unknown) => {
      if (isAgentRunAckPayload(msg)) {
        if (ackTimer != null) {
          clearTimeout(ackTimer);
          ackTimer = null;
        }
        if (!msg.hasActiveRun) {
          finish(false);
          return;
        }
        waitTimer = setTimeout(() => {
          finish(true);
        }, waitMs);
        return;
      }
      if (isAgentRunDonePayload(msg) || isAgentRunErrorPayload(msg)) {
        finish(false);
        return;
      }
    });
    port.onDisconnect.addListener(() => {
      finish(false);
    });

    ackTimer = setTimeout(() => {
      finish(false);
    }, ackTimeoutMs);
  });
}

/**
 * Fire-and-forget STOP request to the SW agent host for a given
 * conversation. Opens a transient port, posts `AGENT_RUN_STOP`, and
 * disconnects. The SW's port-router (`isAgentRunStopPayload` branch)
 * calls `stopRun`, which aborts the underlying transport.
 *
 * Used by the wrapped `stop()` in `useAgentChat` so that a *viewer*
 * surface (whose local `useChat` is in `status: "ready"` because it
 * didn't start the run) can still kill the SW-side run. Calling
 * `chatStop()` alone aborts only the local AI SDK stream — which for a
 * viewer is a no-op against an already-idle local Chat — and would
 * leave the SW run executing tools in the background.
 *
 * Safe to call when no run is active: the port-router silently ignores
 * STOP for conversations with no live handle.
 */
export function abortAgentRun(conversationId: string): void {
  try {
    const port = chrome.runtime.connect({
      name: `${AGENT_RUN_PORT_PREFIX}${conversationId}`,
    });
    try {
      port.postMessage({
        type: AGENT_RUN.STOP,
        conversationId,
      });
    } catch {
      // Port closed before postMessage; nothing to do.
    }
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  } catch {
    // chrome.runtime.connect threw (extension context invalidated, etc.)
  }
}
