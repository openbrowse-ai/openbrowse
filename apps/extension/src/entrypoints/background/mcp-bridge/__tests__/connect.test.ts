import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fake WebSocket for testing. The extension uses the global `WebSocket`
// constructor (no `ws` package — MV3 service workers ship with it).
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState: number = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: 1000 } as CloseEvent);
  }

  // Simulate broker messages
  receive(msg: unknown) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) } as MessageEvent);
  }

  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen({} as Event);
  }
}

describe("mcp-bridge/connect", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
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
    (globalThis as any).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    delete (globalThis as any).WebSocket;
    vi.resetModules();
  });

  it("connects, sends hello-response on hello-challenge, surfaces TOFU prompt on first connect", async () => {
    const { connectToBroker } = await import("../index");
    const onPromptShown = vi.fn();
    const handler = connectToBroker({
      url: "ws://localhost:47821/ws",
      onTofuPrompt: onPromptShown,
    });
    await handler.start();

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:47821/ws");
    ws.open();

    // Broker sends hello-challenge
    ws.receive({
      type: "hello-challenge",
      protocolVersion: 1,
      brokerVersion: "0.0.0",
      publicKeyFingerprint: "fp123",
      processInfo: { pid: 999, executablePath: "/x/openbrowse-mcp", startedAt: 0 },
      nonce: "nonce123",
    });

    // First-time: should NOT auto-send hello-response. Should surface TOFU prompt instead.
    // Wait a microtask cycle for the async handleMessage to complete.
    await new Promise((r) => setTimeout(r, 0));

    expect(onPromptShown).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: "fp123",
        processInfo: expect.objectContaining({ pid: 999 }),
      }),
    );
    // No hello-response sent yet
    expect(ws.sent.length).toBe(0);

    handler.stop();
  });

  it("auto-completes handshake when fingerprint is already trusted", async () => {
    // Pre-trust the broker
    const { trustBroker } = await import("../tofu");
    await trustBroker({
      fingerprint: "fp123",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });

    const { connectToBroker } = await import("../index");
    const onPromptShown = vi.fn();
    const handler = connectToBroker({
      url: "ws://localhost:47821/ws",
      onTofuPrompt: onPromptShown,
    });
    await handler.start();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({
      type: "hello-challenge",
      protocolVersion: 1,
      brokerVersion: "0.0.0",
      publicKeyFingerprint: "fp123",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
      nonce: "n",
    });
    // Wait for async handleMessage
    await new Promise((r) => setTimeout(r, 0));

    // No TOFU prompt — auto-accepted
    expect(onPromptShown).not.toHaveBeenCalled();
    // hello-response was sent
    expect(ws.sent.length).toBe(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent).toMatchObject({
      type: "hello-response",
      protocolVersion: 1,
      extensionVersion: "0.0.0-test",
    });

    handler.stop();
  });

  it("rejects when fingerprint differs from trusted one", async () => {
    const { trustBroker } = await import("../tofu");
    await trustBroker({
      fingerprint: "old_fp",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
    });

    const { connectToBroker } = await import("../index");
    const onMismatch = vi.fn();
    const handler = connectToBroker({
      url: "ws://localhost:47821/ws",
      onKeyMismatch: onMismatch,
    });
    await handler.start();

    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({
      type: "hello-challenge",
      protocolVersion: 1,
      brokerVersion: "0.0.0",
      publicKeyFingerprint: "new_fp_does_not_match",
      processInfo: { pid: 2, executablePath: "/y", startedAt: 0 },
      nonce: "n",
    });
    // Wait for async handleMessage
    await new Promise((r) => setTimeout(r, 0));

    expect(onMismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        storedFingerprint: "old_fp",
        presentedFingerprint: "new_fp_does_not_match",
      }),
    );
    // hello-response NOT sent
    expect(ws.sent.length).toBe(0);
    handler.stop();
  });
});
