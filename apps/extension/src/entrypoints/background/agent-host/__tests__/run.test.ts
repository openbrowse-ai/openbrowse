import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import type { AgentUIMessage } from "@/lib/agent/message-types";
import { createRegistry } from "../registry";
import { startRun, stopRun, type StartRunDeps } from "../run";

vi.mock("../heal-chatdb", () => ({
  healLastAssistantInChatDb: vi.fn().mockResolvedValue({ healed: false }),
}));

// Spy on `resetAgentIndicator` so the ownership-re-check tests below
// can assert it is NOT called when a new run claimed the cid during
// the dynamic-import await window. The same module also exports
// helpers the production code never reaches from run.ts; we only need
// to intercept this one symbol.
const resetAgentIndicatorMock = vi.fn();
vi.mock("@/lib/agent/agent-transport", () => ({
  resetAgentIndicator: resetAgentIndicatorMock,
}));

/**
 * `run.ts` orchestrates one SW-hosted agent turn:
 *
 *   1. Register a handle in the registry.
 *   2. Call the transport's `sendMessages` to get a chunk stream.
 *   3. Tee the chunks: subscribers, persistence, snapshot broadcast.
 *   4. On terminal state: post AGENT_RUN_DONE, broadcast STREAM_DONE,
 *      release the handle.
 *   5. On abort: cancel the stream, post AGENT_RUN_ERROR (or just close),
 *      release the handle.
 *
 * Subscriber ports are an in-memory Set on the `RunHandle`; the test
 * uses a fake-port shape that captures posted messages.
 *
 * Persistence and snapshot-broadcast effects are tested via dependency
 * injection (fake `persister` + spy `snapshot`), keeping this test free
 * of chatDb and chrome.runtime.sendMessage.
 */

interface FakePort {
  name: string;
  posted: unknown[];
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  onDisconnectListeners: Array<() => void>;
  onDisconnect: { addListener: (cb: () => void) => void };
}

function makeFakePort(name: string): FakePort {
  const posted: unknown[] = [];
  const onDisconnectListeners: Array<() => void> = [];
  return {
    name,
    posted,
    postMessage(msg: unknown) {
      posted.push(msg);
    },
    disconnect() {
      onDisconnectListeners.forEach((cb) => cb());
    },
    onDisconnectListeners,
    onDisconnect: {
      addListener(cb: () => void) {
        onDisconnectListeners.push(cb);
      },
    },
  };
}

function chunkStream(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function delayedChunkStream(
  chunks: UIMessageChunk[],
): { stream: ReadableStream<UIMessageChunk>; advance: () => void; close: () => void } {
  const queue = [...chunks];
  let controller: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    advance() {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(next);
    },
    close() {
      controller.close();
    },
  };
}

describe("SW agent-host run.ts", () => {
  let registry: ReturnType<typeof createRegistry>;
  let persistCalls: AgentUIMessage[];
  let snapshotEmits: Array<{ messageId: string }>;
  let snapshotDones: number;

  beforeEach(() => {
    registry = createRegistry();
    persistCalls = [];
    snapshotEmits = [];
    snapshotDones = 0;
    resetAgentIndicatorMock.mockReset();
  });

  function makeDeps(stream: ReadableStream<UIMessageChunk>): StartRunDeps {
    return {
      registry,
      buildTransport: () => ({
        sendMessages: vi.fn().mockResolvedValue(stream),
      }),
      buildPersister: () => ({
        persist: async (m) => {
          persistCalls.push(m);
        },
        final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
      }),
      buildSnapshotBroadcaster: () => ({
        emit: (s) => {
          snapshotEmits.push({ messageId: s.messageId });
        },
        done: () => {
          snapshotDones += 1;
        },
      }),
    };
  }

  it("registers, streams chunks to a single subscriber, then DONE + release", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "a-1" } as unknown as UIMessageChunk,
      { type: "text-start", id: "t-1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "hi" } as unknown as UIMessageChunk,
      { type: "text-end", id: "t-1" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ];
    const port = makeFakePort("agent-run:conv-A");
    const deps = makeDeps(chunkStream(chunks));

    const run = startRun(
      {
        conversationId: "conv-A",
        messages: [],
        origin: "sidepanel",
      },
      deps,
    );
    run.handle.subscribers.add(port as unknown as chrome.runtime.Port);

    await run.completion;

    // Subscriber received every chunk + a final DONE.
    const types = port.posted.map((p) => (p as { type: string }).type);
    expect(types).toContain("AGENT_RUN_CHUNK");
    expect(types[types.length - 1]).toBe("AGENT_RUN_DONE");
    expect(types.filter((t) => t === "AGENT_RUN_CHUNK")).toHaveLength(5);

    // Registry released.
    expect(registry.get("conv-A")).toBeUndefined();

    // Snapshot broadcaster's done() was called.
    expect(snapshotDones).toBe(1);
  });

  it("resume run merges chunks onto the existing assistant message id (no duplicate bubble)", async () => {
    // Regression: post-approval resume used to mint a fresh assistant
    // message id on every transport call, breaking the SDK's resume
    // continuation contract (`Chat.makeRequest` only does
    // `replaceLastMessage` when the new state.message.id matches
    // `this.lastMessage.id`). The visible symptom in Plan mode was a
    // second "I'll propose a plan first" bubble that contained the
    // approved `proposePlan` tool output + the next tool's start,
    // while the original bubble was stranded in `approval-responded`
    // forever. The fix:
    //
    //   1. `compacting-transport.ts` passes `originalMessages` to
    //      `toUIMessageStream` so the SDK's `getResponseUIMessageId`
    //      reuses the last assistant message id.
    //   2. `run.ts` (here) threads the input transcript's trailing
    //      assistant message into `readUIMessageStream({ message })`
    //      so the SW persister's `state.message` is seeded with the
    //      EXISTING parts (proposePlan input + approval) — not an
    //      empty array that would wipe them on first chat-db write.
    //
    // This test verifies (2): given an input transcript whose last
    // message is an assistant with a `proposePlan` part in
    // `approval-responded`, the chunks emitted by the resume stream
    // are persisted to a message that keeps the SAME id as the input
    // assistant message AND preserves its existing parts alongside
    // the new tool-output chunk.
    const resumeMessageId = "a-resume-target";
    const inputAssistant: AgentUIMessage = {
      id: resumeMessageId,
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          toolCallId: "tc-propose-1",
          state: "approval-responded",
          input: { goal: "g", sites: ["https://x.test"], todos: [], allowNetwork: false },
          approval: { id: "ap-1", approved: true },
        },
      ] as unknown as AgentUIMessage["parts"],
    };

    // Stream the SDK would emit on resume: a start chunk reusing the
    // existing assistant message id (which is what
    // `toUIMessageStream({ originalMessages })` produces on the
    // transport side), then the tool-output chunk for the approved
    // tool call, then finish.
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: resumeMessageId } as unknown as UIMessageChunk,
      {
        type: "tool-output-available",
        toolCallId: "tc-propose-1",
        output: { approved: true },
      } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ];

    const deps = makeDeps(chunkStream(chunks));
    const run = startRun(
      {
        conversationId: "conv-resume",
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] } as AgentUIMessage,
          inputAssistant,
        ],
        origin: "sidepanel",
      },
      deps,
    );
    await run.completion;

    // The persister received messages with the SAME id as the input
    // assistant message — not a fresh UUID minted by the transport.
    expect(persistCalls.length).toBeGreaterThan(0);
    const lastPersisted = persistCalls[persistCalls.length - 1];
    expect(lastPersisted.id).toBe(resumeMessageId);

    // The original `proposePlan` part is preserved on the persisted
    // message (proves `readUIMessageStream({ message })` seeded
    // `state.message` with the input assistant, not an empty
    // placeholder that would have wiped the input + approval fields).
    const proposePart = lastPersisted.parts.find(
      (p) =>
        p.type === "dynamic-tool" &&
        (p as { toolName?: string }).toolName === "proposePlan",
    ) as
      | {
          type: "dynamic-tool";
          state: string;
          input?: { goal?: string };
          approval?: { id?: string; approved?: boolean };
        }
      | undefined;
    expect(proposePart).toBeDefined();
    expect(proposePart!.input).toMatchObject({ goal: "g" });
    expect(proposePart!.approval).toMatchObject({ id: "ap-1", approved: true });
    // After the resume's tool-output chunk lands, the SDK advances
    // the part to `output-available` on the EXISTING message — not
    // a duplicate part on a new message.
    expect(proposePart!.state).toBe("output-available");

    // Snapshot broadcaster emitted using the same id (so viewer
    // surfaces apply the snapshot in place rather than appending a
    // duplicate bubble).
    expect(snapshotEmits.some((s) => s.messageId === resumeMessageId)).toBe(true);
  });

  it("fans chunks out to multiple subscribers", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "a-1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "x" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ];
    const portA = makeFakePort("agent-run:conv-A#A");
    const portB = makeFakePort("agent-run:conv-A#B");
    const deps = makeDeps(chunkStream(chunks));

    const run = startRun(
      {
        conversationId: "conv-A",
        messages: [],
        origin: "sidepanel",
      },
      deps,
    );
    run.handle.subscribers.add(portA as unknown as chrome.runtime.Port);
    run.handle.subscribers.add(portB as unknown as chrome.runtime.Port);

    await run.completion;

    const chunkCountA = portA.posted.filter(
      (p) => (p as { type: string }).type === "AGENT_RUN_CHUNK",
    ).length;
    const chunkCountB = portB.posted.filter(
      (p) => (p as { type: string }).type === "AGENT_RUN_CHUNK",
    ).length;
    expect(chunkCountA).toBe(3);
    expect(chunkCountB).toBe(3);
  });

  it("a subscriber added mid-run still receives subsequent chunks", async () => {
    const { stream, advance, close } = delayedChunkStream([
      { type: "start", messageId: "a-1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "first" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "second" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);

    const portEarly = makeFakePort("agent-run:conv-A#early");
    const portLate = makeFakePort("agent-run:conv-A#late");

    const run = startRun(
      {
        conversationId: "conv-A",
        messages: [],
        origin: "sidepanel",
      },
      makeDeps(stream),
    );
    run.handle.subscribers.add(portEarly as unknown as chrome.runtime.Port);

    advance(); // start
    advance(); // first delta
    await new Promise((r) => setTimeout(r, 0));

    // Late subscriber attaches; it should receive the remaining chunks but
    // NOT the chunks already delivered (a fresh subscriber's catch-up of
    // earlier state is the snapshot-broadcast's job, not the chunk fan-out's).
    run.handle.subscribers.add(portLate as unknown as chrome.runtime.Port);

    advance(); // second delta
    advance(); // finish
    close();
    await run.completion;

    const lateChunks = portLate.posted.filter(
      (p) => (p as { type: string }).type === "AGENT_RUN_CHUNK",
    );
    expect(lateChunks.length).toBeGreaterThanOrEqual(1);
    expect(lateChunks.length).toBeLessThan(4); // missed at least 1 earlier
  });

  it("a disconnected subscriber is removed from the fan-out automatically", async () => {
    const { stream, advance, close } = delayedChunkStream([
      { type: "start", messageId: "a-1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "a" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "b" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);
    const port = makeFakePort("agent-run:conv-A");

    const run = startRun(
      {
        conversationId: "conv-A",
        messages: [],
        origin: "sidepanel",
      },
      makeDeps(stream),
    );
    run.handle.subscribers.add(port as unknown as chrome.runtime.Port);

    advance();
    await new Promise((r) => setTimeout(r, 0));
    advance();
    await new Promise((r) => setTimeout(r, 0));
    // Caller disconnects mid-stream.
    port.disconnect();
    run.handle.subscribers.delete(port as unknown as chrome.runtime.Port);

    advance();
    await new Promise((r) => setTimeout(r, 0));
    advance();
    await new Promise((r) => setTimeout(r, 0));
    close();
    await run.completion;

    // Port got the first 2 chunks but NOT the last 2.
    const chunkCount = port.posted.filter(
      (p) => (p as { type: string }).type === "AGENT_RUN_CHUNK",
    ).length;
    expect(chunkCount).toBe(2);

    // But the run still completed and the registry was released.
    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("run continues to completion even when all subscribers disconnect", async () => {
    const { stream, advance, close } = delayedChunkStream([
      { type: "start", messageId: "a-1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "x" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);
    const port = makeFakePort("agent-run:conv-A");
    const run = startRun(
      {
        conversationId: "conv-A",
        messages: [],
        origin: "sidepanel",
      },
      makeDeps(stream),
    );
    run.handle.subscribers.add(port as unknown as chrome.runtime.Port);

    advance();
    await new Promise((r) => setTimeout(r, 0));
    run.handle.subscribers.delete(port as unknown as chrome.runtime.Port);

    advance();
    await new Promise((r) => setTimeout(r, 0));
    advance();
    await new Promise((r) => setTimeout(r, 0));
    close();
    await run.completion;

    expect(registry.get("conv-A")).toBeUndefined();
    // Snapshot broadcast still finalised (display catch-up still useful).
    expect(snapshotDones).toBe(1);
  });

  it("stopRun aborts the underlying stream and tears the run down", async () => {
    // The fake transport in `makeDeps` does not honor the abort signal,
    // but the host MUST still tear down when the run is aborted: it
    // cancels its readers so the pump promises settle. The test transport
    // also passes the abort signal so we can verify it propagates.
    const { stream, advance } = delayedChunkStream([
      { type: "start", messageId: "a-1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "a" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "b" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);
    const port = makeFakePort("agent-run:conv-A");
    const run = startRun(
      {
        conversationId: "conv-A",
        messages: [],
        origin: "sidepanel",
      },
      makeDeps(stream),
    );
    run.handle.subscribers.add(port as unknown as chrome.runtime.Port);

    advance();
    await new Promise((r) => setTimeout(r, 0));
    advance();
    await new Promise((r) => setTimeout(r, 0));

    stopRun(registry, "conv-A");

    await run.completion;

    // Abort signal was fired.
    expect(run.handle.abort.signal.aborted).toBe(true);
    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("throws when starting a run for a conversation that already has one", () => {
    const deps = makeDeps(
      chunkStream([{ type: "finish" } as unknown as UIMessageChunk]),
    );
    startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      deps,
    );
    expect(() =>
      startRun(
        { conversationId: "conv-A", messages: [], origin: "home" },
        deps,
      ),
    ).toThrow(/already/);
  });

  it("emits AGENT_RUN_ERROR to subscribers and releases the handle on transport error", async () => {
    const port = makeFakePort("agent-run:conv-A");
    const errStream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.error(new Error("transport blew up"));
      },
    });
    const deps: StartRunDeps = {
      registry,
      buildTransport: () => ({
        sendMessages: vi.fn().mockResolvedValue(errStream),
      }),
      buildPersister: () => ({
        persist: async (m) => {
          persistCalls.push(m);
        },
        final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
      }),
      buildSnapshotBroadcaster: () => ({
        emit: (s) => {
          snapshotEmits.push({ messageId: s.messageId });
        },
        done: () => {
          snapshotDones += 1;
        },
      }),
    };

    const run = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      deps,
    );
    run.handle.subscribers.add(port as unknown as chrome.runtime.Port);

    await run.completion;

    const errored = port.posted.find(
      (p) => (p as { type: string }).type === "AGENT_RUN_ERROR",
    ) as { message: string } | undefined;
    expect(errored).toBeDefined();
    expect(errored!.message).toContain("transport blew up");
    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("emits AGENT_RUN_ERROR and releases the handle when sendMessages itself rejects", async () => {
    // Companion to the stream-errors test above. The transport's
    // `sendMessages` call can reject before any stream is returned —
    // e.g. provider authentication failure surfaced as a thrown error
    // rather than a streamed `error-text` chunk. The run lifecycle
    // must handle that path identically: post AGENT_RUN_ERROR to
    // subscribers and release the registry handle.
    const port = makeFakePort("agent-run:conv-A");
    const deps: StartRunDeps = {
      registry,
      buildTransport: () => ({
        sendMessages: vi
          .fn()
          .mockRejectedValue(new Error("provider auth failed")),
      }),
      buildPersister: () => ({
        persist: async (m: AgentUIMessage) => {
          persistCalls.push(m);
        },
        final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
      }),
      buildSnapshotBroadcaster: () => ({
        emit: (s) => {
          snapshotEmits.push({ messageId: s.messageId });
        },
        done: () => {
          snapshotDones += 1;
        },
      }),
    };

    const run = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      deps,
    );
    run.handle.subscribers.add(port as unknown as chrome.runtime.Port);

    await run.completion;

    const errored = port.posted.find(
      (p) => (p as { type: string }).type === "AGENT_RUN_ERROR",
    ) as { message: string } | undefined;
    expect(errored).toBeDefined();
    expect(errored!.message).toContain("provider auth failed");
    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("releases the handle if buildPersister throws synchronously during startRun", () => {
    // Regression: `buildTransport`/`buildPersister`/`buildSnapshotBroadcaster`
    // run AFTER `registry.register(handle)`. A synchronous throw from any
    // of them previously left the handle registered with status "running"
    // while no `completion` IIFE ever started — the conversation was
    // permanently wedged until SW restart.
    //
    // Fix: wrap dep construction in try/catch → release + rethrow.
    const deps: StartRunDeps = {
      registry,
      buildTransport: () => ({
        sendMessages: vi.fn().mockResolvedValue(
          new ReadableStream<UIMessageChunk>({ start: (c) => c.close() }),
        ),
      }),
      buildPersister: () => {
        throw new Error("persister build failed");
      },
      buildSnapshotBroadcaster: () => ({
        emit: () => {},
        done: () => {},
      }),
    };

    expect(() =>
      startRun(
        { conversationId: "conv-A", messages: [], origin: "sidepanel" },
        deps,
      ),
    ).toThrow("persister build failed");

    // The handle must NOT be left registered.
    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("releases the handle if buildSnapshotBroadcaster throws synchronously", () => {
    const deps: StartRunDeps = {
      registry,
      buildTransport: () => ({
        sendMessages: vi.fn().mockResolvedValue(
          new ReadableStream<UIMessageChunk>({ start: (c) => c.close() }),
        ),
      }),
      buildPersister: () => ({
        persist: async () => {},
        final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
      }),
      buildSnapshotBroadcaster: () => {
        throw new Error("snapshot build failed");
      },
    };

    expect(() =>
      startRun(
        { conversationId: "conv-A", messages: [], origin: "sidepanel" },
        deps,
      ),
    ).toThrow("snapshot build failed");
    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("releases the handle if buildTransport throws synchronously", () => {
    const deps: StartRunDeps = {
      registry,
      buildTransport: () => {
        throw new Error("transport build failed");
      },
      buildPersister: () => ({
        persist: async () => {},
        final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
      }),
      buildSnapshotBroadcaster: () => ({
        emit: () => {},
        done: () => {},
      }),
    };

    expect(() =>
      startRun(
        { conversationId: "conv-A", messages: [], origin: "sidepanel" },
        deps,
      ),
    ).toThrow("transport build failed");
    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("releases the handle even if snapshot.done() throws on the early-exit path", async () => {
    // Regression: in the transport-error early-exit (run.ts:163-185),
    // an unprotected `snapshot.done()` call could throw and prevent
    // `deps.registry.release(conversationId)` from running, leaking
    // the handle until SW restart. Fix: best-effort wrap so release
    // is guaranteed.
    const deps: StartRunDeps = {
      registry,
      buildTransport: () => ({
        sendMessages: vi.fn().mockRejectedValue(new Error("transport boom")),
      }),
      buildPersister: () => ({
        persist: async () => {},
        final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
      }),
      buildSnapshotBroadcaster: () => ({
        emit: () => {},
        done: () => {
          throw new Error("snapshot done failed");
        },
      }),
    };

    const run = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      deps,
    );
    await run.completion;

    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("releases the handle even if snapshot.done() throws on the normal-termination path", async () => {
    // Same invariant for the success path — `snapshot.done()` is in
    // the outer `finally`, and a throw there must not block the
    // subsequent `resetAgentIndicator` + `registry.release` cleanup.
    const stream = new ReadableStream<UIMessageChunk>({
      start(c) {
        c.enqueue({
          type: "start",
          messageId: "a-1",
        } as unknown as UIMessageChunk);
        c.enqueue({ type: "finish" } as unknown as UIMessageChunk);
        c.close();
      },
    });
    const deps: StartRunDeps = {
      registry,
      buildTransport: () => ({
        sendMessages: vi.fn().mockResolvedValue(stream),
      }),
      buildPersister: () => ({
        persist: async (m) => {
          persistCalls.push(m);
        },
        final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
      }),
      buildSnapshotBroadcaster: () => ({
        emit: () => {},
        done: () => {
          throw new Error("snapshot done failed");
        },
      }),
    };

    const run = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      deps,
    );
    await run.completion;

    expect(registry.get("conv-A")).toBeUndefined();
  });

  it("does NOT reset the indicator or release the registry slot if a new run claimed the cid during the dynamic-import await (normal-termination path)", async () => {
    // Regression: `run.ts`'s finally block does `await import(...)`
    // before calling `resetAgentIndicator(conversationId)` and
    // `deps.registry.release(conversationId)`. The dynamic import is a
    // yield point — the renderer's queue watcher can fire a new run
    // for the same cid during the await (via port-router's
    // terminal-handle eviction + startRun). Without a re-check after
    // the import, the OLD run's cleanup would tear down the NEW run's
    // indicator and evict the NEW handle from the registry.
    //
    // Setup: the mocked `resetAgentIndicator` (intercepting the
    // dynamic-import resolve) flips the registry to simulate a new run
    // claiming the cid right at the moment the old run is about to
    // call `resetAgentIndicator`. The old run's cleanup must detect
    // the swap and bail.
    const newHandle = {
      conversationId: "conv-A",
      abort: new AbortController(),
      startedAt: Date.now() + 1,
      status: "running" as const,
      subscribers: new Set<chrome.runtime.Port>(),
    };
    resetAgentIndicatorMock.mockImplementation(() => {
      // Simulate the queue watcher: evict the old (already terminal)
      // handle, then register a new one for the same cid. This is
      // the same pattern port-router does on a duplicate START.
      registry.release("conv-A");
      registry.register(newHandle);
    });

    const stream = new ReadableStream<UIMessageChunk>({
      start(c) {
        c.enqueue({
          type: "start",
          messageId: "a-1",
        } as unknown as UIMessageChunk);
        c.enqueue({ type: "finish" } as unknown as UIMessageChunk);
        c.close();
      },
    });

    const run = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      makeDeps(stream),
    );
    await run.completion;

    // The new handle must still be registered — the old run's
    // `registry.release(conversationId)` must NOT have evicted it.
    expect(registry.get("conv-A")).toBe(newHandle);
  });

  it("does NOT reset the indicator or release the registry slot if a new run claimed the cid during the early-exit cleanup (transport-error path)", async () => {
    // Same invariant for the early-exit path. `sendMessages` rejects;
    // the catch block does `await import(...)` before reset+release.
    // A new run can race in during that await window via the same
    // queue-watcher path.
    const newHandle = {
      conversationId: "conv-A",
      abort: new AbortController(),
      startedAt: Date.now() + 1,
      status: "running" as const,
      subscribers: new Set<chrome.runtime.Port>(),
    };
    resetAgentIndicatorMock.mockImplementation(() => {
      registry.release("conv-A");
      registry.register(newHandle);
    });

    const deps: StartRunDeps = {
      registry,
      buildTransport: () => ({
        sendMessages: vi.fn().mockRejectedValue(new Error("transport boom")),
      }),
      buildPersister: () => ({
        persist: async (m: AgentUIMessage) => {
          persistCalls.push(m);
        },
        final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
      }),
      buildSnapshotBroadcaster: () => ({
        emit: () => {},
        done: () => {},
      }),
    };

    const run = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      deps,
    );
    await run.completion;

    expect(registry.get("conv-A")).toBe(newHandle);
  });
});
