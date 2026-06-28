import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUN } from "../messages";
import { createRegistry } from "../registry";
import { createPortRouter } from "../port-router";

/**
 * The port router subscribes to `chrome.runtime.onConnect` and routes
 * Ports whose name starts with `agent-run:` to the agent host.
 *
 * Behaviors covered here:
 *   - The router only acts on `agent-run:*` ports; foreign ports are
 *     left untouched (their `onMessage` handler is never invoked).
 *   - On port attach for a conversation with an active run, the router
 *     adds the port to `handle.subscribers` and emits AGENT_RUN_ACK
 *     with `hasActiveRun: true`.
 *   - On port attach for a conversation with no active run, the router
 *     emits AGENT_RUN_ACK with `hasActiveRun: false` and waits for an
 *     AGENT_RUN_START message before invoking the injected `startRun`.
 *   - On `AGENT_RUN_START`, the router invokes the injected `startRun`
 *     with the message payload + handle.subscribers seeded with the
 *     attaching port.
 *   - On `AGENT_RUN_STOP`, the router invokes the injected `stopRun`.
 *   - On `port.disconnect`, the port is removed from `handle.subscribers`
 *     but the run is NOT aborted (matches the "run continues without
 *     subscribers" invariant from Task 2).
 *
 * The router is constructed with dependency-injected `startRun`/`stopRun`
 * functions so this test does not need to spin up real streams.
 */

interface FakePort {
  name: string;
  posted: unknown[];
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
    postMessage(msg) {
      posted.push(msg);
    },
    disconnect() {
      onDisconnectListeners.forEach((cb) => cb());
    },
    onMessageListeners,
    onDisconnectListeners,
    onMessage: { addListener: (cb) => onMessageListeners.push(cb) },
    onDisconnect: { addListener: (cb) => onDisconnectListeners.push(cb) },
  };
}

function deliver(port: FakePort, msg: unknown): void {
  port.onMessageListeners.forEach((cb) => cb(msg));
}

function close(port: FakePort): void {
  port.onDisconnectListeners.forEach((cb) => cb());
}

describe("SW agent-host port router", () => {
  let registry: ReturnType<typeof createRegistry>;
  let startRunCalls: Array<{ conversationId: string; messages: unknown[] }>;
  let stopRunCalls: Array<{ conversationId: string }>;
  let router: ReturnType<typeof createPortRouter>;

  beforeEach(() => {
    registry = createRegistry();
    startRunCalls = [];
    stopRunCalls = [];
    router = createPortRouter({
      registry,
      startRun: vi.fn((payload) => {
        startRunCalls.push({
          conversationId: payload.conversationId,
          messages: payload.messages,
        });
        // Mimic Task 2's `startRun`: register a handle so subsequent
        // attaches see `hasActiveRun: true`.
        const handle = {
          conversationId: payload.conversationId,
          abort: new AbortController(),
          startedAt: Date.now(),
          status: "running" as const,
          subscribers: new Set<chrome.runtime.Port>(),
        };
        registry.register(handle);
        return {
          handle,
          completion: Promise.resolve(),
        };
      }),
      stopRun: vi.fn((reg, conversationId) => {
        stopRunCalls.push({ conversationId });
        const h = reg.get(conversationId);
        h?.abort.abort();
      }),
    });
  });

  it("ignores ports whose name does not start with agent-run:", () => {
    const port = makeFakePort("sidepanel");
    router.handleConnect(port as unknown as chrome.runtime.Port);
    // No ACK should be sent to a non-agent-run port.
    expect(port.posted).toHaveLength(0);
  });

  it("ACKs a fresh attach with hasActiveRun: false when no run exists", () => {
    const port = makeFakePort("agent-run:conv-A");
    router.handleConnect(port as unknown as chrome.runtime.Port);
    expect(port.posted[0]).toMatchObject({
      type: AGENT_RUN.ACK,
      conversationId: "conv-A",
      hasActiveRun: false,
    });
  });

  it("ACKs a fresh attach with hasActiveRun: true and joins subscribers when a run exists", () => {
    // Pre-seed: start a run from the first attacher.
    const portA = makeFakePort("agent-run:conv-A");
    router.handleConnect(portA as unknown as chrome.runtime.Port);
    deliver(portA, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [],
      origin: "sidepanel",
    });
    expect(registry.get("conv-A")).toBeDefined();

    // Second attacher joins.
    const portB = makeFakePort("agent-run:conv-A");
    router.handleConnect(portB as unknown as chrome.runtime.Port);
    expect(portB.posted[0]).toMatchObject({
      type: AGENT_RUN.ACK,
      conversationId: "conv-A",
      hasActiveRun: true,
    });
    expect(
      registry.get("conv-A")?.subscribers.has(
        portB as unknown as chrome.runtime.Port,
      ),
    ).toBe(true);
  });

  it("on AGENT_RUN_START invokes startRun with messages and seeds subscribers with the port", () => {
    const port = makeFakePort("agent-run:conv-A");
    router.handleConnect(port as unknown as chrome.runtime.Port);

    deliver(port, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [{ id: "u-1", role: "user", parts: [] }],
      origin: "home",
    });

    expect(startRunCalls).toHaveLength(1);
    expect(startRunCalls[0]!.conversationId).toBe("conv-A");
    expect(startRunCalls[0]!.messages).toHaveLength(1);
    // After startRun the attacher is in the subscriber set.
    expect(
      registry.get("conv-A")?.subscribers.has(
        port as unknown as chrome.runtime.Port,
      ),
    ).toBe(true);
  });

  it("on AGENT_RUN_STOP invokes stopRun", () => {
    const port = makeFakePort("agent-run:conv-A");
    router.handleConnect(port as unknown as chrome.runtime.Port);
    deliver(port, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [],
      origin: "sidepanel",
    });

    deliver(port, {
      type: AGENT_RUN.STOP,
      conversationId: "conv-A",
    });

    expect(stopRunCalls).toEqual([{ conversationId: "conv-A" }]);
  });

  it("on port disconnect removes the port from subscribers but does not abort the run", () => {
    const port = makeFakePort("agent-run:conv-A");
    router.handleConnect(port as unknown as chrome.runtime.Port);
    deliver(port, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [],
      origin: "sidepanel",
    });

    expect(registry.get("conv-A")?.subscribers.size).toBe(1);
    close(port);
    expect(registry.get("conv-A")?.subscribers.size).toBe(0);
    expect(registry.get("conv-A")?.abort.signal.aborted).toBe(false);
    expect(stopRunCalls).toHaveLength(0);
  });

  it("rejects messages that do not match the AgentRunStart shape", () => {
    const port = makeFakePort("agent-run:conv-A");
    router.handleConnect(port as unknown as chrome.runtime.Port);
    // Malformed: no conversationId.
    deliver(port, { type: AGENT_RUN.START });
    expect(startRunCalls).toHaveLength(0);
  });

  it("rejects messages whose conversationId does not match the port", () => {
    const port = makeFakePort("agent-run:conv-A");
    router.handleConnect(port as unknown as chrome.runtime.Port);
    deliver(port, {
      type: AGENT_RUN.START,
      conversationId: "conv-DIFFERENT",
      messages: [],
      origin: "sidepanel",
    });
    expect(startRunCalls).toHaveLength(0);
  });

  it("a second AGENT_RUN_START on the same port (after the prior run completed) starts a new run", async () => {
    const port = makeFakePort("agent-run:conv-A");
    router.handleConnect(port as unknown as chrome.runtime.Port);
    deliver(port, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [],
      origin: "sidepanel",
    });
    // Simulate prior run completing — release the handle.
    registry.release("conv-A");

    deliver(port, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [{ id: "u-1", role: "user", parts: [] }],
      origin: "sidepanel",
    });

    expect(startRunCalls).toHaveLength(2);
  });

  it("a duplicate AGENT_RUN_START from a different port folds to subscribe-only (no second run)", () => {
    // First port starts the run.
    const portA = makeFakePort("agent-run:conv-A");
    router.handleConnect(portA as unknown as chrome.runtime.Port);
    deliver(portA, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [],
      origin: "sidepanel",
    });
    expect(startRunCalls).toHaveLength(1);

    // Second port (a different surface viewing the same conversation)
    // connects mid-run and ALSO posts AGENT_RUN_START. The router should
    // join it to the existing run's subscribers instead of starting a
    // second run and instead of silently dropping it (which would leave
    // the second renderer waiting for chunks on a dropped START).
    const portB = makeFakePort("agent-run:conv-A");
    router.handleConnect(portB as unknown as chrome.runtime.Port);
    // The ACK should have already auto-attached portB; clear the assertion
    // by ensuring deliver of a second START does not change subscriber set.
    const beforeSize = registry.get("conv-A")?.subscribers.size ?? 0;
    deliver(portB, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [],
      origin: "sidepanel",
    });
    expect(startRunCalls).toHaveLength(1);
    // portB ended up in the subscriber set exactly once (idempotent add).
    expect(registry.get("conv-A")?.subscribers.size).toBe(beforeSize);
    expect(
      registry.get("conv-A")?.subscribers.has(
        portB as unknown as chrome.runtime.Port,
      ),
    ).toBe(true);
  });

  // Regression: the SW's `run.ts` finally block sets `handle.status =
  // "completed"/"aborted"/"errored"` AFTER emitting AGENT_RUN_DONE to
  // existing subscribers but BEFORE calling `registry.release` (because
  // the finally block also runs an async chatDb heal + snapshot.done
  // broadcast in between). During that window the handle is still in
  // the registry, so a probe (from the renderer's auto-flush watcher)
  // that connects in this window would see `hasActiveRun: true` AND
  // miss the AGENT_RUN_DONE that was emitted earlier. The probe would
  // then wait its full timeout (5s) for a terminal event that never
  // arrives, and ultimately return "still running" — so the queue
  // never flushes. Fix: the ACK should report `hasActiveRun: false`
  // once the handle's status is terminal (not "running"). The handle
  // can stay registered to preserve subscriber fanout for snapshot.done's
  // broadcast, but the "is there an active run" signal must reflect
  // the actual run state.
  it("ACKs hasActiveRun: false when the handle exists but its status is terminal", () => {
    // Pre-seed: start a run, then mark it completed without releasing.
    const portA = makeFakePort("agent-run:conv-A");
    router.handleConnect(portA as unknown as chrome.runtime.Port);
    deliver(portA, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [],
      origin: "sidepanel",
    });
    const handle = registry.get("conv-A");
    expect(handle).toBeDefined();
    handle!.status = "completed";

    // A new attacher (the auto-flush probe) connects DURING the finally
    // block, before registry.release runs.
    const portB = makeFakePort("agent-run:conv-A");
    router.handleConnect(portB as unknown as chrome.runtime.Port);
    expect(portB.posted[0]).toMatchObject({
      type: AGENT_RUN.ACK,
      conversationId: "conv-A",
      hasActiveRun: false,
    });
  });

  it("a duplicate START on a terminal-status handle starts a fresh run", () => {
    // Same setup as above: terminal handle still registered.
    const portA = makeFakePort("agent-run:conv-A");
    router.handleConnect(portA as unknown as chrome.runtime.Port);
    deliver(portA, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [],
      origin: "sidepanel",
    });
    expect(startRunCalls).toHaveLength(1);
    const handle = registry.get("conv-A");
    handle!.status = "completed";
    // Do NOT call `registry.release` here: that would bypass the
    // exact code path under test. The router's own logic
    // (`port-router.ts:120-126`) must release the terminal handle
    // before invoking `startRun` again. If the router omits that
    // step, the test setup's `startRun` stub will throw when its
    // `registry.register` call detects a duplicate entry, and the
    // `startRunCalls` count assertion will fail.

    const portB = makeFakePort("agent-run:conv-A");
    router.handleConnect(portB as unknown as chrome.runtime.Port);
    deliver(portB, {
      type: AGENT_RUN.START,
      conversationId: "conv-A",
      messages: [{ id: "m1" }],
      origin: "sidepanel",
    });
    expect(startRunCalls).toHaveLength(2);
  });

  it("a synchronous throw from startRun is surfaced as AGENT_RUN_ERROR + disconnect (#3)", () => {
    // Regression: if `startRun` throws synchronously (e.g. registry
    // refuses a re-register that wasn't evicted), the throw escapes
    // out of the `port.onMessage` callback into the Chrome dispatcher.
    // The ACK has already been posted reporting `hasActiveRun: false`
    // so the renderer's `RemoteChatTransport.sendMessages` would wait
    // forever for a stream that never starts.
    //
    // Fix: wrap `deps.startRun` in try/catch; on catch post
    // `AGENT_RUN_ERROR` through the same port, then disconnect.
    const localRegistry = createRegistry();
    let disconnected = false;
    const router2 = createPortRouter({
      registry: localRegistry,
      startRun: vi.fn(() => {
        throw new Error("registry refused re-register");
      }),
      stopRun: vi.fn(),
    });

    const port = makeFakePort("agent-run:conv-A");
    port.disconnect = () => {
      disconnected = true;
    };
    router2.handleConnect(port as unknown as chrome.runtime.Port);
    expect(() =>
      deliver(port, {
        type: AGENT_RUN.START,
        conversationId: "conv-A",
        messages: [],
        origin: "sidepanel",
      }),
    ).not.toThrow();

    const errMsg = port.posted.find(
      (p) => (p as { type: string }).type === AGENT_RUN.ERROR,
    ) as { conversationId: string; message: string } | undefined;
    expect(errMsg).toBeDefined();
    expect(errMsg!.conversationId).toBe("conv-A");
    expect(errMsg!.message).toContain("registry refused re-register");
    expect(disconnected).toBe(true);
  });
});
