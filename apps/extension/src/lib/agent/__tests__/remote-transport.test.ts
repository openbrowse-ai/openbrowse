import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteChatTransport } from "../remote-transport";

/**
 * `RemoteChatTransport` is the renderer-side `ChatTransport` that
 * proxies the AI SDK's `Chat`/`useChat` to the SW agent host over an
 * `agent-run:<conversationId>` Port:
 *
 *  - On `sendMessages`: open the port, post AGENT_RUN_START with
 *    `messages` + a settings snapshot, return a `ReadableStream` whose
 *    controller is pumped from `port.onMessage` (CHUNK → enqueue,
 *    DONE → close, ERROR → error).
 *
 *  - On `abortSignal.abort()`: post AGENT_RUN_STOP and disconnect the
 *    port so the SW reaps the subscriber slot.
 *
 *  - On `reconnectToStream`: open an attach-only port; if the SW
 *    responds AGENT_RUN_ACK with `hasActiveRun: true`, return the
 *    streamed-chunks pipe; otherwise disconnect and return `null`.
 *
 * The transport does not interpret chunks; the `Chat` / `useChat`
 * consumer in the renderer handles them.
 */

interface FakePort {
  name: string;
  posted: unknown[];
  disconnected: boolean;
  onMessageListeners: Array<(msg: unknown) => void>;
  onDisconnectListeners: Array<() => void>;
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (cb: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
}

function makeFakePort(name: string): FakePort {
  const posted: unknown[] = [];
  const onMessageListeners: Array<(msg: unknown) => void> = [];
  const onDisconnectListeners: Array<() => void> = [];
  return {
    name,
    posted,
    disconnected: false,
    postMessage(msg) {
      posted.push(msg);
    },
    disconnect() {
      // Matches real Chrome semantics: `port.disconnect()` does NOT
      // fire the local `onDisconnect` listener — per the docs, that
      // event is "only fired on the other end." Our fake mirrors this
      // so the unit tests catch bugs that depend on the asymmetry.
      this.disconnected = true;
    },
    onMessageListeners,
    onDisconnectListeners,
    onMessage: { addListener: (cb) => onMessageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => onDisconnectListeners.push(cb) },
  };
}

/**
 * Simulate the *peer* (the SW) disconnecting the port. This DOES fire
 * the local onDisconnect listeners, mirroring real Chrome behavior.
 * Used by tests that exercise SW-side disconnect → local stream error.
 */
function peerDisconnect(port: FakePort): void {
  port.disconnected = true;
  port.onDisconnectListeners.forEach((cb) => cb());
}

function deliver(port: FakePort, msg: unknown): void {
  port.onMessageListeners.forEach((cb) => cb(msg));
}

describe("RemoteChatTransport", () => {
  let lastPort: FakePort;
  let connect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connect = vi.fn((opts: { name: string }) => {
      lastPort = makeFakePort(opts.name);
      return lastPort as unknown as chrome.runtime.Port;
    });
    vi.stubGlobal("chrome", {
      runtime: {
        connect,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sendMessages opens an agent-run:<conversationId> port", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      { agentModel: "anthropic:claude-3", spaceId: null },
      "sidepanel",
    );
    void transport.sendMessages({
      trigger: "submit-message",
      chatId: "conv-A",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    expect(connect).toHaveBeenCalledWith({ name: "agent-run:conv-A" });
  });

  it("sendMessages posts AGENT_RUN_START with payload + settings snapshot", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      {
        agentModel: "openai:gpt-4o",
        spaceId: "sp-1",
        thinkingEnabled: true,
        thinkingConfig: { mode: "auto" } as never,
      },
      "home",
    );
    void transport.sendMessages({
      trigger: "submit-message",
      chatId: "conv-A",
      messageId: undefined,
      messages: [{ id: "u-1", role: "user", parts: [] } as never],
      abortSignal: undefined,
    });
    const startMsg = lastPort.posted[0] as Record<string, unknown>;
    expect(startMsg.type).toBe("AGENT_RUN_START");
    expect(startMsg.conversationId).toBe("conv-A");
    expect(startMsg.origin).toBe("home");
    expect(startMsg.messages).toHaveLength(1);
    expect(startMsg.settingsSnapshot).toMatchObject({
      agentModel: "openai:gpt-4o",
      spaceId: "sp-1",
      thinkingEnabled: true,
    });
  });

  it("returned ReadableStream yields chunks delivered over the port", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      { agentModel: "x:y", spaceId: null },
      "sidepanel",
    );
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "conv-A",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    const reader = stream.getReader();

    // Simulate SW pushing chunks.
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: false,
    });
    deliver(lastPort, {
      type: "AGENT_RUN_CHUNK",
      conversationId: "conv-A",
      chunk: { type: "text-delta", id: "t-1", delta: "hi" },
    });
    deliver(lastPort, {
      type: "AGENT_RUN_CHUNK",
      conversationId: "conv-A",
      chunk: { type: "text-delta", id: "t-1", delta: "!" },
    });
    deliver(lastPort, { type: "AGENT_RUN_DONE", conversationId: "conv-A" });

    const c1 = await reader.read();
    expect(c1.value).toMatchObject({ type: "text-delta", delta: "hi" });
    const c2 = await reader.read();
    expect(c2.value).toMatchObject({ type: "text-delta", delta: "!" });
    const c3 = await reader.read();
    expect(c3.done).toBe(true);
  });

  it("AGENT_RUN_ERROR errors the ReadableStream", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      { agentModel: "x:y", spaceId: null },
      "sidepanel",
    );
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "conv-A",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    const reader = stream.getReader();

    deliver(lastPort, {
      type: "AGENT_RUN_ERROR",
      conversationId: "conv-A",
      message: "boom",
    });

    await expect(reader.read()).rejects.toThrow(/boom/);
  });

  it("port disconnect errors the ReadableStream", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      { agentModel: "x:y", spaceId: null },
      "sidepanel",
    );
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "conv-A",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    const reader = stream.getReader();

    // SW-side disconnect — fires our local onDisconnect listener.
    peerDisconnect(lastPort);
    await expect(reader.read()).rejects.toThrow();
  });

  it("aborting via abortSignal posts AGENT_RUN_STOP and disconnects the port", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      { agentModel: "x:y", spaceId: null },
      "sidepanel",
    );
    const ac = new AbortController();
    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "conv-A",
      messageId: undefined,
      messages: [],
      abortSignal: ac.signal,
    });
    ac.abort();
    const stopMsg = lastPort.posted.find(
      (p) => (p as { type?: string }).type === "AGENT_RUN_STOP",
    );
    expect(stopMsg).toBeDefined();
    expect(lastPort.disconnected).toBe(true);
  });

  // Regression: clicking Stop (or pressing Esc x2) used to leave the
  // chat stuck in `streaming` state. Root cause:
  //   1. `chat.stop()` aborts the AI SDK's abortController.
  //   2. Our `wireAbort` posts AGENT_RUN_STOP and calls
  //      `port.disconnect()`.
  //   3. Per Chrome docs, calling `disconnect()` on a port does NOT
  //      fire the local `onDisconnect` listener — only the *peer*
  //      end gets that event. So our `makeChunkStream`'s controller
  //      was never closed/errored.
  //   4. AI SDK's `consumeStream` (which doesn't honor abortSignal)
  //      hangs on `reader.read()` forever, so the SDK's status never
  //      transitions out of `streaming`.
  // Fix: when our abort handler fires, also error the stream's
  // controller directly so the SDK's consumer rejects.
  it("aborting via abortSignal errors the local ReadableStream (so AI SDK transitions out of streaming)", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      { agentModel: "x:y", spaceId: null },
      "sidepanel",
    );
    const ac = new AbortController();
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "conv-A",
      messageId: undefined,
      messages: [],
      abortSignal: ac.signal,
    });
    const reader = stream.getReader();
    ac.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it("reconnectToStream resolves to a stream when the SW reports an active run", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      { agentModel: "x:y", spaceId: null },
      "sidepanel",
    );
    const p = transport.reconnectToStream({ chatId: "conv-A" });
    // SW responds: there is an active run.
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: true,
    });
    const stream = await p;
    expect(stream).not.toBeNull();
    const reader = stream!.getReader();
    deliver(lastPort, {
      type: "AGENT_RUN_CHUNK",
      conversationId: "conv-A",
      chunk: { type: "text-delta", id: "t-1", delta: "x" },
    });
    deliver(lastPort, { type: "AGENT_RUN_DONE", conversationId: "conv-A" });
    expect((await reader.read()).value).toMatchObject({ delta: "x" });
    expect((await reader.read()).done).toBe(true);
  });

  it("reconnectToStream resolves to null when the SW reports no active run", async () => {
    const transport = new RemoteChatTransport(
      "conv-A",
      { agentModel: "x:y", spaceId: null },
      "sidepanel",
    );
    const p = transport.reconnectToStream({ chatId: "conv-A" });
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: false,
    });
    const stream = await p;
    expect(stream).toBeNull();
    expect(lastPort.disconnected).toBe(true);
  });

  it("reconnectToStream resolves to null and disconnects after the ACK timeout if the SW never replies", async () => {
    // Regression: a port could attach but never receive AGENT_RUN_ACK
    // (e.g. SW dies mid-onConnect, port-router throws before posting).
    // Without a watchdog the promise would hang forever, leaving the
    // renderer wedged. Fix: bounded ACK timeout (5s) → disconnect +
    // resolve null. Keep aligned with `probeAgentRunAwaitIdle`'s budget.
    vi.useFakeTimers();
    try {
      const transport = new RemoteChatTransport(
        "conv-A",
        { agentModel: "x:y", spaceId: null },
        "sidepanel",
      );
      const p = transport.reconnectToStream({ chatId: "conv-A" });
      // Do NOT deliver any ACK. Advance past the timeout.
      await vi.advanceTimersByTimeAsync(5_000 + 1);
      const stream = await p;
      expect(stream).toBeNull();
      expect(lastPort.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnectToStream clears the ACK timeout once the ACK arrives", async () => {
    // Tighter contract: if the ACK arrives in time, the timeout should
    // be cleared so it doesn't fire spuriously later and disconnect a
    // healthy stream.
    vi.useFakeTimers();
    try {
      const transport = new RemoteChatTransport(
        "conv-A",
        { agentModel: "x:y", spaceId: null },
        "sidepanel",
      );
      const p = transport.reconnectToStream({ chatId: "conv-A" });
      deliver(lastPort, {
        type: "AGENT_RUN_ACK",
        conversationId: "conv-A",
        hasActiveRun: true,
      });
      const stream = await p;
      expect(stream).not.toBeNull();
      expect(lastPort.disconnected).toBe(false);
      // Advance past the would-be deadline; the port must still be
      // attached so the stream stays alive.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(lastPort.disconnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("origin defaults to 'sidepanel' if not provided", async () => {
    const transport = new RemoteChatTransport("conv-X", {
      agentModel: "x:y",
      spaceId: null,
    });
    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "conv-X",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    expect((lastPort.posted[0] as { origin?: string }).origin).toBe(
      "sidepanel",
    );
  });
});

/**
 * `probeAgentRun(cid)` opens a transient port to the SW agent host,
 * reads the AGENT_RUN_ACK, and resolves with the `hasActiveRun` flag.
 * The port is always disconnected on resolution (it's an information
 * probe, not a subscription).
 *
 * Used by `useAgentChat.handleSubmit` to make a final pre-flight check
 * before submitting a turn: if the SW reports an active run, the
 * renderer diverts to `queueMessage` instead of opening a duplicate
 * START (which the port router silently folds into a viewer-attach,
 * dropping the new payload — see port-router.ts:96-106).
 *
 * Bug scenario (root cause):
 *   1. SW has an active run for conv-A (long delegate-to-subagent step
 *      that's blocked for >30s).
 *   2. Renderer's initiator watchdog fires (no message-list activity)
 *      → calls `chat.stop()` → status → `ready` → `setAgentInactive`.
 *   3. SW run keeps going (the watchdog's stop didn't fully propagate
 *      to the subagent in time, OR the watchdog was on a renderer that
 *      wasn't the original initiator).
 *   4. User types a new message + Enter. ChatInput's `isLoading` is
 *      false (status=ready AND isAgentActiveGlobally=false), so it
 *      submits instead of queueing.
 *   5. `handleSubmit` heals stranded tool parts (showing "Interrupted"
 *      badge), opens a new port.
 *   6. Port router sees an active run, folds the new port into viewer
 *      attach, the NEW message payload is silently dropped.
 *   7. Renderer's local `useChat.messages` has the new user message,
 *      but chatDb doesn't, so other surfaces never see it.
 *
 * `probeAgentRun` catches this state by asking the SW directly before
 * we commit anything user-visible.
 */
describe("probeAgentRun", () => {
  let lastPort: FakePort;
  let connect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connect = vi.fn((opts: { name: string }) => {
      lastPort = makeFakePort(opts.name);
      return lastPort as unknown as chrome.runtime.Port;
    });
    vi.stubGlobal("chrome", {
      runtime: {
        connect,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves true when the SW responds with hasActiveRun: true", async () => {
    const { probeAgentRun } = await import("../remote-transport");
    const p = probeAgentRun("conv-A");
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: true,
    });
    await expect(p).resolves.toBe(true);
    expect(lastPort.disconnected).toBe(true);
  });

  it("resolves false when the SW responds with hasActiveRun: false", async () => {
    const { probeAgentRun } = await import("../remote-transport");
    const p = probeAgentRun("conv-A");
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: false,
    });
    await expect(p).resolves.toBe(false);
    expect(lastPort.disconnected).toBe(true);
  });

  it("resolves false on port disconnect before any ACK (SW unavailable)", async () => {
    const { probeAgentRun } = await import("../remote-transport");
    const p = probeAgentRun("conv-A");
    peerDisconnect(lastPort);
    await expect(p).resolves.toBe(false);
  });

  it("resolves false on timeout if no ACK arrives", async () => {
    vi.useFakeTimers();
    try {
      const { probeAgentRun } = await import("../remote-transport");
      const p = probeAgentRun("conv-A", { timeoutMs: 100 });
      vi.advanceTimersByTime(150);
      await expect(p).resolves.toBe(false);
      expect(lastPort.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens an agent-run:<conversationId> port (not a sendMessage)", async () => {
    const { probeAgentRun } = await import("../remote-transport");
    void probeAgentRun("conv-B");
    expect(connect).toHaveBeenCalledWith({ name: "agent-run:conv-B" });
  });
});

/**
 * `probeAgentRunAwaitIdle(cid)` is the auto-flush watcher's probe.
 * Unlike the one-shot `probeAgentRun`, when the SW reports an active
 * run this version stays attached to the port and waits for the run
 * to emit its terminal event (AGENT_RUN_DONE / AGENT_RUN_ERROR) before
 * resolving false. This closes the race where the SW's
 * run-termination sequence (heal → broadcast STREAM_DONE → registry.release)
 * hasn't finished yet but the renderer has already noticed status
 * flip to ready (from the port-side AGENT_RUN_DONE that's emitted
 * BEFORE the finally block runs heal/release).
 */
describe("probeAgentRunAwaitIdle", () => {
  let lastPort: FakePort;
  let connect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connect = vi.fn((opts: { name: string }) => {
      lastPort = makeFakePort(opts.name);
      return lastPort as unknown as chrome.runtime.Port;
    });
    vi.stubGlobal("chrome", {
      runtime: {
        connect,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves false immediately when no active run", async () => {
    const { probeAgentRunAwaitIdle } = await import("../remote-transport");
    const p = probeAgentRunAwaitIdle("conv-A");
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: false,
    });
    await expect(p).resolves.toBe(false);
    expect(lastPort.disconnected).toBe(true);
  });

  it("resolves false AFTER the SW emits AGENT_RUN_DONE on an active run", async () => {
    const { probeAgentRunAwaitIdle } = await import("../remote-transport");
    const p = probeAgentRunAwaitIdle("conv-A");
    // SW says "yes, there's an active run". Probe stays attached.
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: true,
    });
    // Probe should still be unresolved at this point.
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    // Now SW terminates the run.
    deliver(lastPort, {
      type: "AGENT_RUN_DONE",
      conversationId: "conv-A",
    });
    await expect(p).resolves.toBe(false);
  });

  it("resolves false AFTER the SW emits AGENT_RUN_ERROR on an active run", async () => {
    const { probeAgentRunAwaitIdle } = await import("../remote-transport");
    const p = probeAgentRunAwaitIdle("conv-A");
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: true,
    });
    deliver(lastPort, {
      type: "AGENT_RUN_ERROR",
      conversationId: "conv-A",
      message: "boom",
    });
    await expect(p).resolves.toBe(false);
  });

  it("resolves false on peer port disconnect (SW eviction)", async () => {
    const { probeAgentRunAwaitIdle } = await import("../remote-transport");
    const p = probeAgentRunAwaitIdle("conv-A");
    peerDisconnect(lastPort);
    await expect(p).resolves.toBe(false);
  });

  it("resolves true if the run stays active for the full waitMs window", async () => {
    vi.useFakeTimers();
    try {
      const { probeAgentRunAwaitIdle } = await import("../remote-transport");
      const p = probeAgentRunAwaitIdle("conv-A", { waitMs: 100 });
      deliver(lastPort, {
        type: "AGENT_RUN_ACK",
        conversationId: "conv-A",
        hasActiveRun: true,
      });
      // No terminal event. Advance past waitMs.
      vi.advanceTimersByTime(150);
      await expect(p).resolves.toBe(true);
      expect(lastPort.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores CHUNK messages while waiting", async () => {
    const { probeAgentRunAwaitIdle } = await import("../remote-transport");
    const p = probeAgentRunAwaitIdle("conv-A");
    deliver(lastPort, {
      type: "AGENT_RUN_ACK",
      conversationId: "conv-A",
      hasActiveRun: true,
    });
    // Chunks should be silently dropped — probe stays unresolved.
    deliver(lastPort, {
      type: "AGENT_RUN_CHUNK",
      conversationId: "conv-A",
      chunk: { type: "text-delta", id: "x", delta: "..." },
    });
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    deliver(lastPort, {
      type: "AGENT_RUN_DONE",
      conversationId: "conv-A",
    });
    await expect(p).resolves.toBe(false);
  });
});

/**
 * `abortAgentRun` is the fire-and-forget STOP that viewer surfaces use
 * to kill the SW-side run. The wrapped `stop()` in `useAgentChat`
 * needs this because the AI SDK's local `chatStop()` only aborts the
 * local stream — which for a viewer is a no-op (its `useChat` never
 * started a run). Without an explicit STOP message the SW would keep
 * running tools in the background after the user clicked Stop.
 */
describe("abortAgentRun", () => {
  let lastPort: FakePort;
  let connect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    connect = vi.fn((opts: { name: string }) => {
      lastPort = makeFakePort(opts.name);
      return lastPort as unknown as chrome.runtime.Port;
    });
    vi.stubGlobal("chrome", {
      runtime: {
        connect,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects, posts AGENT_RUN_STOP, then disconnects", async () => {
    const { abortAgentRun } = await import("../remote-transport");
    abortAgentRun("conv-A");
    expect(connect).toHaveBeenCalledWith({ name: "agent-run:conv-A" });
    expect(lastPort.posted).toEqual([
      { type: "AGENT_RUN_STOP", conversationId: "conv-A" },
    ]);
    expect(lastPort.disconnected).toBe(true);
  });

  it("swallows errors from chrome.runtime.connect", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        connect: vi.fn(() => {
          throw new Error("Extension context invalidated");
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    });
    const { abortAgentRun } = await import("../remote-transport");
    // Must not throw — viewers may call this on unload paths.
    expect(() => abortAgentRun("conv-A")).not.toThrow();
  });

  it("swallows errors from postMessage but still disconnects", async () => {
    const { abortAgentRun } = await import("../remote-transport");
    // Replace the connect to return a port whose postMessage throws.
    connect.mockImplementationOnce((opts: { name: string }) => {
      lastPort = makeFakePort(opts.name);
      lastPort.postMessage = () => {
        throw new Error("port closed");
      };
      return lastPort as unknown as chrome.runtime.Port;
    });
    expect(() => abortAgentRun("conv-A")).not.toThrow();
    expect(lastPort.disconnected).toBe(true);
  });
});
