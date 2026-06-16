/**
 * Tests for tab-scoping's registry integration: ownership keyed on
 * LogicalTabId means `chrome.tabs.onReplaced` (Speculation Rules /
 * prerender activation) leaves ownership intact, the side panel is
 * re-registered against the new ctid, and the trailing `onRemoved` for
 * the old ctid is suppressed by the registry's dedup window so ownership
 * isn't accidentally cleared.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import { tabRegistry } from "@/lib/agent/tab-registry";

describe("tab-scoping: registry integration", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
    // We do NOT call vi.resetModules() here: tab-scoping imports
    // tab-registry, and a reset would give tab-scoping a *different*
    // registry instance from the one our test owns, breaking the link
    // between our `__handleReplaceForTests` calls and tab-scoping's
    // subscriptions. Module-level state is reset via the explicit
    // helpers above.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
  });

  function installChromeStub() {
    const sidePanelCalls: { tabId?: number; enabled?: boolean }[] = [];
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test",
        sendMessage: () => Promise.resolve({ ok: true }),
        lastError: undefined,
      },
      tabs: {
        get: (id: number) =>
          Promise.resolve({
            id,
            url: `https://x/${id}`,
            title: "t",
            windowId: 1,
            pinned: false,
          } as chrome.tabs.Tab),
        remove: () => Promise.resolve(),
        query: () => Promise.resolve([]),
        sendMessage: () => Promise.resolve(undefined),
        group: () => Promise.resolve(7),
        onRemoved: { addListener: () => {}, removeListener: () => {} },
        onReplaced: { addListener: () => {}, removeListener: () => {} },
        onUpdated: { addListener: () => {}, removeListener: () => {} },
        onActivated: { addListener: () => {}, removeListener: () => {} },
        onCreated: { addListener: () => {}, removeListener: () => {} },
      },
      tabGroups: {
        update: () => Promise.resolve(),
        onRemoved: { addListener: () => {} },
        TAB_GROUP_ID_NONE: -1,
      },
      sidePanel: {
        setOptions: (opts: { tabId?: number; enabled?: boolean }) => {
          sidePanelCalls.push(opts);
          return Promise.resolve();
        },
      },
      storage: {
        session: {
          get: () => Promise.resolve({}),
          set: () => Promise.resolve(),
        },
      },
    });
    return { sidePanelCalls };
  }

  it("getConversationForTab survives onReplaced", async () => {
    const { sidePanelCalls } = installChromeStub();
    void sidePanelCalls;
    const tabScoping = await import("../tab-scoping");

    // Seed a conversation owning ctid 100 via the public API. This
    // mints an ltid via the registry under the hood.
    await chatDb.createConversation({
      id: "c1",
      title: "t",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    await tabScoping.bindTabsToConversation("c1", [100]);

    expect(tabScoping.getConversationForTab(100)).toBe("c1");

    // Drive an onReplaced 100 → 200 through the registry.
    tabRegistry.__handleReplaceForTests!(200, 100);

    // Ownership survived the replace: the new ctid 200 resolves to c1.
    expect(tabScoping.getConversationForTab(200)).toBe("c1");
    // The OLD ctid 100 no longer resolves (registry re-keyed away from it).
    expect(tabScoping.getConversationForTab(100)).toBeNull();
  });

  it("re-enables side panel on the new ctid post-onReplaced", async () => {
    const { sidePanelCalls } = installChromeStub();
    // Need to install the listeners so onReplace fires the
    // setPanelEnabledForTab path. initTabScoping wires them.
    const tabScoping = await import("../tab-scoping");
    tabScoping.initTabScoping();

    await chatDb.createConversation({
      id: "c1",
      title: "t",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    await tabScoping.bindTabsToConversation("c1", [100]);

    sidePanelCalls.length = 0;
    tabRegistry.__handleReplaceForTests!(200, 100);

    // Allow microtask drain for the async setPanelEnabledForTab.
    await Promise.resolve();
    await Promise.resolve();

    const enableCalls = sidePanelCalls.filter((c) => c.tabId === 200 && c.enabled === true);
    expect(enableCalls.length).toBeGreaterThan(0);
  });

  it("does NOT clear ownership on the trailing onRemoved after onReplaced", async () => {
    installChromeStub();
    const tabScoping = await import("../tab-scoping");
    tabScoping.initTabScoping();

    await chatDb.createConversation({
      id: "c1",
      title: "t",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    await tabScoping.bindTabsToConversation("c1", [100]);

    // Sequence Chrome actually fires: onReplaced(200, 100) then
    // onRemoved(100). The registry's dedup window must suppress the
    // trailing onRemoved so consumers don't see it as a tab close.
    tabRegistry.__handleReplaceForTests!(200, 100);
    tabRegistry.__handleRemoveForTests!(100);

    // Ownership intact on the new ctid.
    expect(tabScoping.getConversationForTab(200)).toBe("c1");
  });

  it("clears ownership when the registry emits a real onRemove (no preceding replace)", async () => {
    installChromeStub();
    const tabScoping = await import("../tab-scoping");
    tabScoping.initTabScoping();

    await chatDb.createConversation({
      id: "c1",
      title: "t",
      spaceId: null,
      createdAt: 0,
      updatedAt: 0,
    });
    await tabScoping.bindTabsToConversation("c1", [100]);

    tabRegistry.__handleRemoveForTests!(100);
    // Allow the async clearTabOwnershipForLtid to drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(tabScoping.getConversationForTab(100)).toBeNull();
  });
});
