import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the refactored `boot.ts` state machine. Focus is on the
 * pure surface: `getStatus`, `onStatusChange`, `forceReconnectNow`,
 * `clearTrustAndReconnect`. The full WS lifecycle is already covered
 * by `connect.test.ts`; here we exercise the emitter contract and
 * timer behavior without standing up a WebSocket at all.
 */

// Fake WebSocket — same shape as connect.test.ts but trimmed.
class FakeWS {
  static instances: FakeWS[] = [];
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    if (this.onclose) this.onclose({ code: 1000 } as CloseEvent);
  }
  open() {
    if (this.onopen) this.onopen({} as Event);
  }
  receive(msg: unknown) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) } as MessageEvent);
  }
}

describe("mcp-bridge/boot — emitter + state machine", () => {
  beforeEach(() => {
    FakeWS.instances = [];
    const store: Record<string, unknown> = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(store, obj);
          }),
          remove: vi.fn(async (key: string) => {
            delete store[key];
          }),
        },
      },
      runtime: {
        getManifest: () => ({ version: "0.0.0-test" }),
      },
    };
    (globalThis as any).WebSocket = FakeWS;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
    delete (globalThis as any).WebSocket;
    vi.resetModules();
  });

  it("starts in `disconnected` state", async () => {
    const { getStatus } = await import("../boot");
    expect(getStatus()).toEqual({ kind: "disconnected" });
  });

  it("transitions to `connecting` then `awaiting_tofu` on first handshake", async () => {
    const { bootMcpBridge, getStatus, onStatusChange } = await import("../boot");
    const seen: string[] = [];
    onStatusChange((s) => seen.push(s.kind));
    await bootMcpBridge("ws://localhost:1/ws");
    expect(getStatus().kind).toBe("connecting");
    const ws = FakeWS.instances[0];
    ws.open();
    ws.receive({
      type: "hello-challenge",
      protocolVersion: 1,
      brokerVersion: "0.0.0",
      publicKeyFingerprint: "fp",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
      nonce: "n",
    });
    // Wait for async handleMessage to settle (uses getTrustedFingerprint).
    await Promise.resolve();
    await Promise.resolve();
    expect(getStatus().kind).toBe("awaiting_tofu");
    expect(seen).toEqual(["connecting", "awaiting_tofu"]);
  });

  it("transitions to `connected` on hello-proof and carries broker version + sessionId", async () => {
    const { bootMcpBridge, getStatus } = await import("../boot");
    // Pre-trust so the handshake completes without TOFU.
    const { trustBroker } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });
    await bootMcpBridge("ws://localhost:1/ws");
    const ws = FakeWS.instances[0];
    ws.open();
    ws.receive({
      type: "hello-challenge",
      protocolVersion: 1,
      brokerVersion: "1.2.3",
      publicKeyFingerprint: "fp",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
      nonce: "n",
    });
    await Promise.resolve();
    await Promise.resolve();
    ws.receive({ type: "hello-proof", signature: "sig", sessionId: "sess-abc" });
    await Promise.resolve();
    const s = getStatus();
    expect(s.kind).toBe("connected");
    if (s.kind === "connected") {
      expect(s.brokerVersion).toBe("1.2.3");
      expect(s.sessionId).toBe("sess-abc");
      expect(typeof s.connectedAt).toBe("number");
    }
  });

  it("onStatusChange unsubscribe stops further callbacks", async () => {
    const { bootMcpBridge, onStatusChange } = await import("../boot");
    const cb = vi.fn();
    const unsubscribe = onStatusChange(cb);
    await bootMcpBridge("ws://localhost:1/ws");
    const before = cb.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    unsubscribe();
    // Trigger another transition.
    const ws = FakeWS.instances[0];
    ws.close();
    expect(cb.mock.calls.length).toBe(before);
  });

  it("scheduled reconnect fires after 5s; forceReconnectNow cancels it", async () => {
    const { bootMcpBridge, forceReconnectNow, getStatus } = await import("../boot");
    await bootMcpBridge("ws://localhost:1/ws");
    const ws = FakeWS.instances[0];
    ws.close();
    // After disconnect, status is `disconnected` and a 5s timer is pending.
    expect(getStatus().kind).toBe("disconnected");
    // forceReconnectNow cancels timer and creates a new WS immediately.
    const beforeInstances = FakeWS.instances.length;
    await forceReconnectNow();
    expect(FakeWS.instances.length).toBe(beforeInstances + 1);
    // Advancing past the original 5s shouldn't create yet another WS.
    vi.advanceTimersByTime(10_000);
    expect(FakeWS.instances.length).toBe(beforeInstances + 1);
  });

  it("clearTrustAndReconnect wipes the trusted fingerprint", async () => {
    const { bootMcpBridge, clearTrustAndReconnect } = await import("../boot");
    const { trustBroker, getTrustedFingerprint } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });
    expect(await getTrustedFingerprint()).toBe("fp");
    await bootMcpBridge("ws://localhost:1/ws");
    await clearTrustAndReconnect();
    expect(await getTrustedFingerprint()).toBeNull();
  });

  it("attemptCount resets to 0 after successful connect, then increments on next attempt", async () => {
    const { bootMcpBridge, getStatus, forceReconnectNow } = await import("../boot");
    const { trustBroker } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });
    await bootMcpBridge("ws://localhost:1/ws");
    expect((getStatus() as { attempt?: number }).attempt).toBe(1);
    const ws = FakeWS.instances[0];
    ws.open();
    ws.receive({
      type: "hello-challenge",
      protocolVersion: 1,
      brokerVersion: "v",
      publicKeyFingerprint: "fp",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
      nonce: "n",
    });
    await Promise.resolve();
    await Promise.resolve();
    ws.receive({ type: "hello-proof", signature: "sig", sessionId: "s" });
    await Promise.resolve();
    expect(getStatus().kind).toBe("connected");
    // Tear down and reconnect. Counter starts at 1 again because the
    // successful connect reset it.
    await forceReconnectNow();
    expect((getStatus() as { attempt?: number }).attempt).toBe(1);
  });
});
