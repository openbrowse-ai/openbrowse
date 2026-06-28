import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Realm-aware bridges for the tab-binding RPCs. SW callers invoke
 * `bindTabsToConversation` directly; renderer callers send via
 * `chrome.runtime.sendMessage`.
 */

describe("bindTabsRPC / bindActiveTabRPC realm dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("in renderer context, sends BIND_TABS_TO_CONVERSATION via sendMessage", async () => {
    vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
    vi.stubGlobal("document", {
      URL: "chrome-extension://test/sidepanel.html",
    });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    vi.resetModules();
    const { bindTabsRPC } = await import("../tab-binding-rpc");
    await bindTabsRPC("conv-A", [42, 43]);

    expect(sendMessage).toHaveBeenCalledWith({
      type: "BIND_TABS_TO_CONVERSATION",
      conversationId: "conv-A",
      tabIds: [42, 43],
    });
  });

  it("in SW context, calls bindTabsToConversation in-process", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const bindTabsToConversation = vi
      .fn()
      .mockResolvedValue({ groupId: null });
    const maybeGenerateGroupLabel = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/entrypoints/background/tab-scoping", () => ({
      bindTabsToConversation,
    }));
    vi.doMock("@/entrypoints/background/group-label", () => ({
      maybeGenerateGroupLabel,
    }));

    vi.resetModules();
    const { bindTabsRPC } = await import("../tab-binding-rpc");
    await bindTabsRPC("conv-A", [42, 43]);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(bindTabsToConversation).toHaveBeenCalledWith("conv-A", [42, 43]);
    // No group label fired because result.groupId was null.
    expect(maybeGenerateGroupLabel).not.toHaveBeenCalled();
  });

  it("in SW context, fires group-label generation when a groupId is returned", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    vi.doMock("@/entrypoints/background/tab-scoping", () => ({
      bindTabsToConversation: vi.fn().mockResolvedValue({ groupId: 99 }),
    }));
    const maybeGenerateGroupLabel = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/entrypoints/background/group-label", () => ({
      maybeGenerateGroupLabel,
    }));

    vi.resetModules();
    const { bindTabsRPC } = await import("../tab-binding-rpc");
    await bindTabsRPC("conv-A", [42]);
    expect(maybeGenerateGroupLabel).toHaveBeenCalledWith("conv-A", 99);
  });

  it("bindActiveTabRPC in SW context routes through bindTabsToConversation with a single id", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    const bindTabsToConversation = vi
      .fn()
      .mockResolvedValue({ groupId: null });
    vi.doMock("@/entrypoints/background/tab-scoping", () => ({
      bindTabsToConversation,
    }));
    vi.doMock("@/entrypoints/background/group-label", () => ({
      maybeGenerateGroupLabel: vi.fn(),
    }));

    vi.resetModules();
    const { bindActiveTabRPC } = await import("../tab-binding-rpc");
    await bindActiveTabRPC("conv-A", 77);

    expect(bindTabsToConversation).toHaveBeenCalledWith("conv-A", [77]);
  });

  it("in renderer context, bindActiveTabRPC sends BIND_ACTIVE_TAB_TO_CONVERSATION via sendMessage", async () => {
    vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
    vi.stubGlobal("document", {
      URL: "chrome-extension://test/sidepanel.html",
    });
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    vi.resetModules();
    const { bindActiveTabRPC } = await import("../tab-binding-rpc");
    await bindActiveTabRPC("conv-A", 77);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
      conversationId: "conv-A",
      tabId: 77,
    });
  });

  it("swallows handler errors as best-effort (matches the inlined try/catch behaviour)", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    vi.doMock("@/entrypoints/background/tab-scoping", () => ({
      bindTabsToConversation: vi
        .fn()
        .mockRejectedValue(new Error("background wedged")),
    }));
    vi.doMock("@/entrypoints/background/group-label", () => ({
      maybeGenerateGroupLabel: vi.fn(),
    }));

    vi.resetModules();
    const { bindTabsRPC } = await import("../tab-binding-rpc");
    // Must not throw — the agent loop treats binding as best-effort.
    await expect(bindTabsRPC("conv-A", [1])).resolves.toBeUndefined();
  });
});
