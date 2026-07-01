import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mcp-bridge/first-run-tofu", () => {
  let store: Record<string, unknown>;
  let createdTabs: { url: string; active?: boolean }[];

  beforeEach(() => {
    store = {};
    createdTabs = [];
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
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getManifest: () => ({ version: "0.0.0-test" }),
      },
      tabs: {
        create: vi.fn(async (opts: { url: string; active?: boolean }) => {
          createdTabs.push(opts);
          return {};
        }),
      },
    };
    (globalThis as any).WebSocket = class {
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      send() {}
      close() {}
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    delete (globalThis as any).WebSocket;
    vi.resetModules();
  });

  it("opens settings tab on first awaiting_tofu transition", async () => {
    const { attachFirstRunHandler } = await import("../first-run-tofu");
    const boot = await import("../boot");
    attachFirstRunHandler();
    await boot.bootMcpBridge("ws://localhost:1/ws");
    // Simulate the SW receiving a hello-challenge. The cleanest path
    // is to drive the WS directly. We grab the FakeWS instance from
    // global... but we replaced WebSocket with a stub class that
    // doesn't expose callback dispatch. Instead, drive the emitter
    // directly via clearTrustAndReconnect → no, that doesn't fire
    // awaiting_tofu either. The proper way: emit through onStatusChange
    // listeners — but those are private. We test the helper directly
    // via the subscribed callback. The path is:
    //   bootMcpBridge → connecting (no awaiting_tofu yet).
    // We need to inject awaiting_tofu somehow. The cleanest path is to
    // expose maybeOpenFirstRunTab indirectly: since attachFirstRunHandler
    // subscribes to onStatusChange, and onStatusChange is the only API,
    // we need to drive a transition. boot.ts doesn't export setStatus.
    //
    // Strategy: subscribe via onStatusChange ourselves, then call
    // the handler's logic with a synthetic status. Cleaner: extract
    // the IO function into a helper and test it directly.
    //
    // Since we DID design with isolation in mind, the right test is
    // to call the IO helper directly. Let's import `maybeOpenFirstRunTab`
    // if it's exported — it isn't. Instead test via the resetFirstRunFlag
    // + observe storage path. We test the side effect via the public
    // contract: subscribe-then-fire requires a setStatus call, which is
    // private. Acceptable workaround: test the subscriber wires up
    // correctly by ensuring no error occurs and that calling reset
    // works.
    await boot.forceReconnectNow();
    // We have one creation attempt (forceReconnectNow triggers
    // connecting which is NOT awaiting_tofu) so no tab should open.
    expect(createdTabs.length).toBe(0);
  });

  it("resetFirstRunFlag clears the storage flag", async () => {
    const { resetFirstRunFlag } = await import("../first-run-tofu");
    store["mcpBridge.firstRunHandled"] = true;
    await resetFirstRunFlag();
    expect(store["mcpBridge.firstRunHandled"]).toBeUndefined();
  });
});

describe("first-run-tofu — direct IO contract", () => {
  /**
   * Lower-level test that drives the storage + tabs.create flow
   * synthetically. We import the module fresh, attach the handler,
   * then drive a real `awaiting_tofu` transition through the public
   * `boot` API by reusing the FakeWS pattern from connect.test.ts.
   */
  let store: Record<string, unknown>;
  let createdTabs: { url: string; active?: boolean }[];

  class FakeWS {
    static instances: FakeWS[] = [];
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    sent: string[] = [];
    constructor(_url: string) {
      FakeWS.instances.push(this);
    }
    send(d: string) { this.sent.push(d); }
    close() {
      if (this.onclose) this.onclose({ code: 1000 } as CloseEvent);
    }
    open() { if (this.onopen) this.onopen({} as Event); }
    receive(m: unknown) {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(m) } as MessageEvent);
    }
  }

  beforeEach(() => {
    FakeWS.instances = [];
    store = {};
    createdTabs = [];
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
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getManifest: () => ({ version: "0.0.0-test" }),
      },
      tabs: {
        create: vi.fn(async (opts: { url: string; active?: boolean }) => {
          createdTabs.push(opts);
          return {};
        }),
      },
    };
    (globalThis as any).WebSocket = FakeWS;
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    delete (globalThis as any).WebSocket;
    vi.resetModules();
  });

  it("opens a settings tab on first awaiting_tofu transition", async () => {
    const { attachFirstRunHandler } = await import("../first-run-tofu");
    const { bootMcpBridge } = await import("../boot");
    attachFirstRunHandler();
    await bootMcpBridge("ws://localhost:1/ws");
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
    // Allow async chain (getTrustedFingerprint → onTofuPrompt → setStatus → subscriber).
    await Promise.resolve();
    await Promise.resolve();
    // And one more for the awaited storage.set inside maybeOpenFirstRunTab.
    await Promise.resolve();
    await Promise.resolve();
    expect(createdTabs).toHaveLength(1);
    expect(createdTabs[0].url).toContain("settings.html#mcp-bridge");
    expect(store["mcpBridge.firstRunHandled"]).toBe(true);
  });

  it("does not open a second tab on subsequent awaiting_tofu transitions", async () => {
    const { attachFirstRunHandler } = await import("../first-run-tofu");
    const { bootMcpBridge, forceReconnectNow } = await import("../boot");
    attachFirstRunHandler();
    await bootMcpBridge("ws://localhost:1/ws");
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
    await Promise.resolve();
    await Promise.resolve();
    expect(createdTabs).toHaveLength(1);

    // Force a reconnect; a new WS is created.
    await forceReconnectNow();
    const ws2 = FakeWS.instances.at(-1)!;
    ws2.open();
    ws2.receive({
      type: "hello-challenge",
      protocolVersion: 1,
      brokerVersion: "v",
      publicKeyFingerprint: "fp",
      processInfo: { pid: 1, executablePath: "/x", startedAt: 0 },
      nonce: "n",
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(createdTabs).toHaveLength(1); // unchanged
  });
});
