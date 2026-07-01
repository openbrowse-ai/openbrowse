import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the `mcp-bridge:prompts` push channel. Mirror the
 * structure of `mcp-bridge-status-port.test.ts`: we stub
 * `chrome.runtime.onConnect` so the test can fire fake connect
 * events, and exercise the emitter via the public confirmation API.
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
    onMessage: {
      addListener: (cb) => {
        port.onMessage.listeners.push(cb);
      },
      listeners: [],
    },
    onDisconnect: {
      addListener: (cb) => {
        port.onDisconnect.listeners.push(cb);
      },
      listeners: [],
    },
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

describe("mcp-bridge-prompts-port", () => {
  let onConnectListener: ((p: FakePort) => void) | null = null;

  beforeEach(() => {
    onConnectListener = null;
    const store: Record<string, unknown> = {};
    (globalThis as any).chrome = {
      runtime: {
        onConnect: {
          addListener: (cb: (p: FakePort) => void) => {
            onConnectListener = cb;
          },
        },
        sendMessage: vi.fn(),
      },
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
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    vi.resetModules();
  });

  it("ignores ports with a different name", async () => {
    const { attachPromptsPort } = await import("../mcp-bridge-prompts-port");
    attachPromptsPort();
    expect(onConnectListener).not.toBeNull();
    const port = makeFakePort("some-other-port");
    onConnectListener!(port);
    expect(port.posted).toEqual([]);
  });

  it("sends an empty snapshot immediately on connect", async () => {
    const { attachPromptsPort, PROMPTS_PORT_NAME } = await import(
      "../mcp-bridge-prompts-port"
    );
    attachPromptsPort();
    const port = makeFakePort(PROMPTS_PORT_NAME);
    onConnectListener!(port);
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]).toEqual({
      type: "MCP_BRIDGE_PROMPTS_TICK",
      prompts: [],
    });
  });

  it("pushes a fresh snapshot when a pending prompt is added then removed", async () => {
    const { attachPromptsPort, PROMPTS_PORT_NAME } = await import(
      "../mcp-bridge-prompts-port"
    );
    attachPromptsPort();
    const port = makeFakePort(PROMPTS_PORT_NAME);
    onConnectListener!(port);

    // Force a prompt to register: set always-prompt policy and call
    // awaitConfirmation. We don't await the returned promise; we
    // only need the registration side-effect.
    const { setPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "always-prompt");
    const { awaitConfirmation, listPendingPrompts, confirmPrompt } =
      await import("../mcp-bridge/confirmation");
    const promise = awaitConfirmation({
      clientId: "c1",
      hostName: "Cursor",
      prompt: "x",
      targetWindowInfo: { windowId: 1 },
      hostRequest: "auto",
    });
    await new Promise((r) => setTimeout(r, 0));

    // First add → port should receive a tick with one prompt.
    const addedTick = (port.posted as { type: string; prompts: unknown[] }[]).at(-1);
    expect(addedTick?.type).toBe("MCP_BRIDGE_PROMPTS_TICK");
    expect(addedTick?.prompts).toHaveLength(1);

    // Resolve the prompt → port should receive an empty-list tick.
    const promptId = listPendingPrompts()[0].promptId;
    confirmPrompt(promptId, "allow");
    await promise;
    const removedTick = (port.posted as { type: string; prompts: unknown[] }[]).at(-1);
    expect(removedTick?.prompts).toHaveLength(0);
  });

  it("unsubscribes from the emitter on disconnect", async () => {
    const { attachPromptsPort, PROMPTS_PORT_NAME } = await import(
      "../mcp-bridge-prompts-port"
    );
    attachPromptsPort();
    const port = makeFakePort(PROMPTS_PORT_NAME);
    onConnectListener!(port);
    const initialPostCount = port.posted.length;
    port.disconnect();

    // After disconnect, even adding a prompt should not push to this
    // port. We verify by triggering a state change and checking that
    // posted length hasn't grown.
    const { setPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "always-prompt");
    const { awaitConfirmation } = await import("../mcp-bridge/confirmation");
    void awaitConfirmation({
      clientId: "c1",
      hostName: "h",
      prompt: "x",
      targetWindowInfo: { windowId: 1 },
      hostRequest: "auto",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(port.posted.length).toBe(initialPostCount);
  });

  it("swallows postMessage failures (port closed between snapshot and unsubscribe)", async () => {
    const { attachPromptsPort, PROMPTS_PORT_NAME } = await import(
      "../mcp-bridge-prompts-port"
    );
    attachPromptsPort();
    const port = makeFakePort(PROMPTS_PORT_NAME, true);
    expect(() => onConnectListener!(port)).not.toThrow();
  });
});
