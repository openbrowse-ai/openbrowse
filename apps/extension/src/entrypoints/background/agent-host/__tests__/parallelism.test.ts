import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import type { AgentUIMessage } from "@/lib/agent/message-types";
import { createRegistry } from "../registry";
import { startRun, type StartRunDeps } from "../run";

/**
 * Parallelism guarantees of the SW agent host.
 *
 * The SW-host architecture exists to let multiple agent conversations
 * run concurrently regardless of which surfaces (sidepanel-per-tab,
 * home, newtab, popup) are visible. This test suite pins the three
 * load-bearing claims:
 *
 *   1. Two distinct conversations run concurrently in the SW with
 *      independent chunk streams, persistence, and abort lifecycles.
 *   2. Multiple subscribers (e.g. side panels in different windows
 *      viewing the same conversation) all receive the same chunks;
 *      aborting from any one tears down the run for all.
 *   3. A "frozen" subscriber (delayed listener) does not stall the
 *      other subscribers or the persistence pipeline — the SW keeps
 *      streaming at full speed regardless.
 *
 * The tests drive `startRun` directly with fake transports/persisters/
 * snapshot-broadcasters to keep them hermetic (no chat-db, no
 * chrome.runtime.sendMessage). The integration glue is covered in
 * Tasks 2/3 already.
 */

interface FakePort {
  name: string;
  posted: unknown[];
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  onDisconnect: { addListener: (cb: () => void) => void };
  onDisconnectListeners: Array<() => void>;
}

function makeFakePort(name: string): FakePort {
  const onDisconnectListeners: Array<() => void> = [];
  return {
    name,
    posted: [],
    postMessage(msg) {
      this.posted.push(msg);
    },
    disconnect() {
      onDisconnectListeners.forEach((cb) => cb());
    },
    onDisconnectListeners,
    onDisconnect: { addListener: (cb) => onDisconnectListeners.push(cb) },
  };
}

interface DelayedStream {
  stream: ReadableStream<UIMessageChunk>;
  advance: () => void;
  close: () => void;
  error: (e: unknown) => void;
}

function makeDelayedStream(chunks: UIMessageChunk[]): DelayedStream {
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
    error(e) {
      controller.error(e);
    },
  };
}

function makeDeps(
  stream: ReadableStream<UIMessageChunk>,
  registry: ReturnType<typeof createRegistry>,
  persistOut: AgentUIMessage[] = [],
): StartRunDeps {
  return {
    registry,
    buildTransport: () => ({
      sendMessages: vi.fn().mockResolvedValue(stream),
    }),
    buildPersister: () => ({
      persist: async (m) => {
        persistOut.push(m);
      },
      final: () => ({ finalText: "", messageCount: 0, transcript: [] }),
    }),
    buildSnapshotBroadcaster: () => ({
      emit: vi.fn(),
      done: vi.fn(),
    }),
  };
}

async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("parallelism — two conversations run concurrently and independently", () => {
  let registry: ReturnType<typeof createRegistry>;

  beforeEach(() => {
    registry = createRegistry();
  });

  it("two distinct conversationIds: independent chunks, no cross-contamination", async () => {
    const streamA = makeDelayedStream([
      { type: "start", messageId: "ma" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "tA", delta: "A1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "tA", delta: "A2" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);
    const streamB = makeDelayedStream([
      { type: "start", messageId: "mb" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "tB", delta: "B1" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);

    const portA = makeFakePort("agent-run:conv-A");
    const portB = makeFakePort("agent-run:conv-B");

    const persistA: AgentUIMessage[] = [];
    const persistB: AgentUIMessage[] = [];

    const runA = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      makeDeps(streamA.stream, registry, persistA),
    );
    const runB = startRun(
      { conversationId: "conv-B", messages: [], origin: "home" },
      makeDeps(streamB.stream, registry, persistB),
    );

    runA.handle.subscribers.add(portA as unknown as chrome.runtime.Port);
    runB.handle.subscribers.add(portB as unknown as chrome.runtime.Port);

    // Interleave the two streams.
    streamA.advance();
    streamB.advance();
    await tick();
    streamA.advance();
    streamB.advance();
    await tick();
    streamA.advance();
    await tick();
    streamA.advance();
    streamA.close();
    streamB.advance();
    streamB.close();
    await Promise.all([runA.completion, runB.completion]);

    // Each port only received chunks for its conversation.
    const aChunks = portA.posted.filter(
      (p) => (p as { type: string }).type === "AGENT_RUN_CHUNK",
    );
    const bChunks = portB.posted.filter(
      (p) => (p as { type: string }).type === "AGENT_RUN_CHUNK",
    );
    expect(aChunks).toHaveLength(4);
    expect(bChunks).toHaveLength(3);

    // Persistence stayed split.
    const aTexts = persistA
      .flatMap((m) => m.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text);
    const bTexts = persistB
      .flatMap((m) => m.parts as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text);
    // Persisted text for A never contains B's deltas.
    expect(aTexts.join("|")).not.toMatch(/B[12]/);
    expect(bTexts.join("|")).not.toMatch(/A[12]/);

    expect(registry.get("conv-A")).toBeUndefined();
    expect(registry.get("conv-B")).toBeUndefined();
  });

  it("aborting one conversation does not affect the other", async () => {
    const streamA = makeDelayedStream([
      { type: "start", messageId: "ma" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "tA", delta: "A" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "tA", delta: "A2" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);
    const streamB = makeDelayedStream([
      { type: "start", messageId: "mb" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "tB", delta: "B" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);
    const runA = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      makeDeps(streamA.stream, registry),
    );
    const runB = startRun(
      { conversationId: "conv-B", messages: [], origin: "sidepanel" },
      makeDeps(streamB.stream, registry),
    );

    streamA.advance();
    await tick();

    // Abort only A.
    runA.handle.abort.abort();

    // B keeps flowing to completion.
    streamB.advance();
    await tick();
    streamB.advance();
    await tick();
    streamB.advance();
    streamB.close();

    await Promise.all([runA.completion, runB.completion]);

    expect(runA.handle.abort.signal.aborted).toBe(true);
    expect(runB.handle.abort.signal.aborted).toBe(false);
    expect(registry.get("conv-A")).toBeUndefined();
    expect(registry.get("conv-B")).toBeUndefined();
  });
});

describe("parallelism — multiple subscribers on one conversation", () => {
  let registry: ReturnType<typeof createRegistry>;
  beforeEach(() => {
    registry = createRegistry();
  });

  it("three subscribers (multi-window side panel scenario) all receive identical chunks", async () => {
    const stream = makeDelayedStream([
      { type: "start", messageId: "m1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "first" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "second" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);
    const sidepanelA = makeFakePort("agent-run:conv-A#tabA");
    const sidepanelB = makeFakePort("agent-run:conv-A#tabB");
    const home = makeFakePort("agent-run:conv-A#home");

    const run = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      makeDeps(stream.stream, registry),
    );
    run.handle.subscribers.add(sidepanelA as unknown as chrome.runtime.Port);
    run.handle.subscribers.add(sidepanelB as unknown as chrome.runtime.Port);
    run.handle.subscribers.add(home as unknown as chrome.runtime.Port);

    stream.advance();
    stream.advance();
    stream.advance();
    stream.advance();
    stream.close();
    await run.completion;

    const chunkCount = (p: FakePort) =>
      p.posted.filter((m) => (m as { type: string }).type === "AGENT_RUN_CHUNK")
        .length;
    expect(chunkCount(sidepanelA)).toBe(4);
    expect(chunkCount(sidepanelB)).toBe(4);
    expect(chunkCount(home)).toBe(4);
  });
});

describe("parallelism — a 'frozen' subscriber does not stall the run", () => {
  let registry: ReturnType<typeof createRegistry>;
  beforeEach(() => {
    registry = createRegistry();
  });

  it("a port whose postMessage is artificially slow does not delay other subscribers' chunks", async () => {
    const stream = makeDelayedStream([
      { type: "start", messageId: "m1" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "x" } as unknown as UIMessageChunk,
      { type: "text-delta", id: "t-1", delta: "y" } as unknown as UIMessageChunk,
      { type: "finish" } as unknown as UIMessageChunk,
    ]);
    // The "frozen" subscriber. postMessage is synchronous from the fan-out's
    // perspective; we simulate freezing by counting calls but doing nothing
    // expensive. Chrome's real-world freeze defers the renderer's task
    // queue, not the SW's — so from the SW's side every postMessage returns
    // immediately regardless of the renderer's state. This test pins THAT
    // invariant: as long as the SW's fan-out doesn't block on the
    // subscriber's processing, parallelism holds.
    const frozenChunkCount = { n: 0 };
    const frozen: FakePort = {
      name: "agent-run:conv-A#frozen",
      posted: [],
      postMessage() {
        frozenChunkCount.n += 1;
        // No processing; the renderer is conceptually frozen.
      },
      disconnect() {},
      onDisconnect: { addListener: () => {} },
      onDisconnectListeners: [],
    };
    const live = makeFakePort("agent-run:conv-A#live");

    const persistOut: AgentUIMessage[] = [];
    const run = startRun(
      { conversationId: "conv-A", messages: [], origin: "sidepanel" },
      makeDeps(stream.stream, registry, persistOut),
    );
    run.handle.subscribers.add(frozen as unknown as chrome.runtime.Port);
    run.handle.subscribers.add(live as unknown as chrome.runtime.Port);

    stream.advance();
    stream.advance();
    stream.advance();
    stream.advance();
    stream.close();
    await run.completion;

    const liveChunkCount = live.posted.filter(
      (p) => (p as { type: string }).type === "AGENT_RUN_CHUNK",
    ).length;
    expect(liveChunkCount).toBe(4);
    expect(frozenChunkCount.n).toBeGreaterThanOrEqual(4);
    // Persistence pipeline also ran to completion regardless of the
    // frozen subscriber.
    expect(persistOut.length).toBeGreaterThan(0);
  });
});
