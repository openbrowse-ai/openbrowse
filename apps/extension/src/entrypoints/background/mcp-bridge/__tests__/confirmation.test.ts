import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => Object.assign(store, obj)),
      },
    },
    runtime: {
      sendMessage: vi.fn(),
    },
  };
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as any).chrome;
  vi.useRealTimers();
});

describe("mcp-bridge/confirmation", () => {
  it("auto-allow policy + host auto → resolves to allow without prompting", async () => {
    const { setPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "auto-allow");
    const { awaitConfirmation } = await import("../confirmation");
    const outcome = await awaitConfirmation({
      clientId: "c1",
      hostName: "Cursor",
      prompt: "do x",
      targetWindowInfo: { windowId: 1 },
      hostRequest: "auto",
    });
    expect(outcome).toBe("allow");
  });

  it("blocked policy → throws host_blocked", async () => {
    const { setPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "blocked");
    const { awaitConfirmation } = await import("../confirmation");
    await expect(
      awaitConfirmation({
        clientId: "c1", hostName: "Cursor", prompt: "x",
        targetWindowInfo: { windowId: 1 }, hostRequest: "auto",
      }),
    ).rejects.toThrow(/host_blocked/);
  });

  it("always-prompt policy registers a pending prompt and resolves on confirm", async () => {
    // The default policy changed to `auto-allow` in 2026-06-29; tests
    // that rely on a prompt being registered must opt back in
    // explicitly via setPolicy.
    const { setPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "always-prompt");
    const { awaitConfirmation, confirmPrompt, listPendingPrompts } = await import("../confirmation");
    const promise = awaitConfirmation({
      clientId: "c1", hostName: "Cursor", prompt: "x",
      targetWindowInfo: { windowId: 1 }, hostRequest: "auto",
    });
    // Microtask: let awaitConfirmation register the pending entry
    await new Promise((r) => setTimeout(r, 0));
    const pending = listPendingPrompts();
    expect(pending).toHaveLength(1);
    const promptId = pending[0].promptId;
    confirmPrompt(promptId, "allow");
    expect(await promise).toBe("allow");
    expect(listPendingPrompts()).toHaveLength(0);
  });

  it("Deny outcome resolves to deny and clears the pending entry", async () => {
    const { setPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "always-prompt");
    const { awaitConfirmation, confirmPrompt, listPendingPrompts } = await import("../confirmation");
    const promise = awaitConfirmation({
      clientId: "c1", hostName: "Cursor", prompt: "x",
      targetWindowInfo: { windowId: 1 }, hostRequest: "auto",
    });
    await new Promise((r) => setTimeout(r, 0));
    confirmPrompt(listPendingPrompts()[0].promptId, "deny");
    expect(await promise).toBe("deny");
  });

  it("auto-denies after 60 seconds with no response", async () => {
    const { setPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "always-prompt");
    vi.useFakeTimers();
    const { awaitConfirmation, listPendingPrompts } = await import("../confirmation");
    const promise = awaitConfirmation({
      clientId: "c1", hostName: "Cursor", prompt: "x",
      targetWindowInfo: { windowId: 1 }, hostRequest: "auto",
    });
    // advanceTimersByTimeAsync flushes the async resolveConfirmation chain
    // (resolveConfirmation -> getPolicy -> readMap -> storage.local.get)
    // between ticks. No magic-number microtask count needed.
    await vi.advanceTimersByTimeAsync(0);
    expect(listPendingPrompts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await promise).toBe("deny");
    expect(listPendingPrompts()).toHaveLength(0);
  });
});
