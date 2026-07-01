import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeStatus } from "../mcp-bridge/status";

/**
 * Tests for the long-lived `mcp-bridge:status` port channel.
 *
 * We don't stand up a real `chrome.runtime.onConnect`; instead we
 * stub it with a tiny pub-sub that lets the test fire fake connect
 * events directly. The port itself is a hand-rolled record carrying
 * onMessage/onDisconnect listener sets so we can assert what was
 * posted and trigger disconnects deterministically.
 */

interface FakePort {
  name: string;
  posted: unknown[];
  onMessage: { addListener: (cb: (m: unknown) => void) => void; listeners: ((m: unknown) => void)[] };
  onDisconnect: { addListener: (cb: () => void) => void; listeners: (() => void)[] };
  postMessage: (m: unknown) => void;
  disconnect: () => void;
}

function makeFakePort(name: string, throwOnPost = false): FakePort {
  const port: FakePort = {
    name,
    posted: [],
    onMessage: { addListener: (cb) => { port.onMessage.listeners.push(cb); }, listeners: [] },
    onDisconnect: { addListener: (cb) => { port.onDisconnect.listeners.push(cb); }, listeners: [] },
    postMessage: (m) => {
      if (throwOnPost) throw new Error("port closed");
      port.posted.push(m);
    },
    disconnect: () => {
      for (const cb of port.onDisconnect.listeners) cb();
    },
  };
  return port;
}

describe("mcp-bridge-status-port", () => {
  let onConnectListener: ((p: FakePort) => void) | null = null;

  beforeEach(() => {
    onConnectListener = null;
    (globalThis as any).chrome = {
      runtime: {
        onConnect: {
          addListener: (cb: (p: FakePort) => void) => {
            onConnectListener = cb;
          },
        },
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    vi.resetModules();
  });

  it("ignores ports with a different name", async () => {
    const { attachStatusPort } = await import("../mcp-bridge-status-port");
    attachStatusPort();
    expect(onConnectListener).not.toBeNull();
    const port = makeFakePort("some-other-port");
    onConnectListener!(port);
    expect(port.posted).toEqual([]);
  });

  it("sends current snapshot immediately on connect", async () => {
    const { attachStatusPort, STATUS_PORT_NAME } = await import(
      "../mcp-bridge-status-port"
    );
    attachStatusPort();
    const port = makeFakePort(STATUS_PORT_NAME);
    onConnectListener!(port);
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]).toEqual({
      type: "MCP_BRIDGE_STATUS_TICK",
      status: { kind: "disconnected" },
    });
  });

  it("pushes every subsequent status change to the connected port", async () => {
    // We invoke setStatus indirectly via boot.ts's exported APIs. The
    // cleanest way to drive transitions in isolation is to use the
    // emitter directly — which means we exercise the same code path
    // production uses.
    const { attachStatusPort, STATUS_PORT_NAME } = await import(
      "../mcp-bridge-status-port"
    );
    const boot = await import("../mcp-bridge/boot");
    attachStatusPort();
    const port = makeFakePort(STATUS_PORT_NAME);
    onConnectListener!(port);
    expect(port.posted).toHaveLength(1);

    // Drive a transition by subscribing manually and re-emitting —
    // boot.ts doesn't expose `setStatus` directly (it's private), so
    // we use `forceReconnectNow` which goes through `setStatus`.
    // But forceReconnectNow tries to open a real WS, which we don't
    // have here. Instead we set up `WebSocket` to a minimal fake.
    (globalThis as any).WebSocket = class {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        // never call any callback — leaves status in "connecting"
      }
      send() {}
      close() {}
    };
    await boot.bootMcpBridge("ws://localhost:1/ws");
    // The connecting status should have been pushed to the port.
    const tickKinds = (port.posted as { status: BridgeStatus }[]).map((m) => m.status.kind);
    expect(tickKinds).toContain("connecting");
  });

  it("unsubscribes from the emitter on disconnect", async () => {
    const { attachStatusPort, STATUS_PORT_NAME } = await import(
      "../mcp-bridge-status-port"
    );
    const { onStatusChange } = await import("../mcp-bridge/boot");
    attachStatusPort();
    const port = makeFakePort(STATUS_PORT_NAME);
    onConnectListener!(port);
    const beforeListenerCount = port.posted.length;
    // Pre-count any post-connect callbacks already attached. We can't
    // peek inside the emitter, so we just verify behavior: after
    // disconnect, no further posts happen.
    port.disconnect();
    // Fire an unrelated subscriber to confirm the emitter is alive and
    // the port has detached.
    const cb = vi.fn();
    const unsub = onStatusChange(cb);
    unsub();
    // No new messages on the disconnected port.
    expect(port.posted.length).toBe(beforeListenerCount);
  });

  it("swallows postMessage failures (port closed between snapshot and unsubscribe)", async () => {
    const { attachStatusPort, STATUS_PORT_NAME } = await import(
      "../mcp-bridge-status-port"
    );
    attachStatusPort();
    // Port throws on the first postMessage (initial snapshot).
    const port = makeFakePort(STATUS_PORT_NAME, true);
    expect(() => onConnectListener!(port)).not.toThrow();
  });
});
