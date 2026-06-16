import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import { tabRegistry } from "@/lib/agent/tab-registry";

function installChromeStub(removed: number[]) {
  const tabsById: Record<number, chrome.tabs.Tab> = {
    101: { id: 101, url: "https://a.com/x", title: "A", windowId: 1, index: 0, pinned: false } as chrome.tabs.Tab,
    102: { id: 102, url: "https://b.com/y", title: "B", windowId: 1, index: 1, pinned: false } as chrome.tabs.Tab,
  };
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test-extension",
      sendMessage: () => Promise.resolve({ ok: true }),
      lastError: undefined,
    },
    tabs: {
      get: (id: number) => Promise.resolve(tabsById[id]),
      remove: (ids: number | number[]) => {
        (Array.isArray(ids) ? ids : [ids]).forEach((i) => removed.push(i));
        return Promise.resolve();
      },
      query: () => Promise.resolve([]),
      onRemoved: { addListener: () => {}, removeListener: () => {} },
      onReplaced: { addListener: () => {}, removeListener: () => {} },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onActivated: { addListener: () => {}, removeListener: () => {} },
    },
    tabGroups: { onRemoved: { addListener: () => {} }, TAB_GROUP_ID_NONE: -1 },
    storage: { session: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  });
}

describe("closeOwnedTabs", () => {
  let ltid101: string;
  let ltid102: string;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
    // Mint ltids for the fake ctids 101 and 102 so closeOwnedTabs can
    // resolve them via the registry. In production the registry would
    // have minted these via `bindTabsToConversation` (or the v15
    // migration) before the conversation was persisted.
    ltid101 = tabRegistry.registerExisting(101);
    ltid102 = tabRegistry.registerExisting(102);
    await chatDb.createConversation({
      id: "conv-1",
      title: "t",
      spaceId: null,
      ownedGroupId: 7,
      ownedLtids: [ltid101, ltid102],
      createdAt: 0,
      updatedAt: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
  });

  it("removes the given tabs, returns an undo payload, and clears ownership", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    const { closeOwnedTabs } = await import("../tab-scoping");

    const undo = await closeOwnedTabs("conv-1", [ltid101, ltid102]);

    expect(removed.sort()).toEqual([101, 102]);
    expect(undo.action).toBe("reopen");
    expect(undo.tabs).toEqual([
      { url: "https://a.com/x", windowId: 1, pinned: false },
      { url: "https://b.com/y", windowId: 1, pinned: false },
    ]);
    const conv = await chatDb.getConversation("conv-1");
    expect(conv?.ownedLtids).toEqual([]);
  });

  it("nulls ownedGroupId when all owned tabs are closed", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    const { closeOwnedTabs } = await import("../tab-scoping");

    await closeOwnedTabs("conv-1", [ltid101, ltid102]);

    const conv = await chatDb.getConversation("conv-1");
    expect(conv?.ownedGroupId).toBeNull();
  });

  it("keeps ownedGroupId and remaining tab when only some are closed", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    const { closeOwnedTabs } = await import("../tab-scoping");

    await closeOwnedTabs("conv-1", [ltid101]);

    const conv = await chatDb.getConversation("conv-1");
    expect(conv?.ownedLtids).toEqual([ltid102]);
    expect(conv?.ownedGroupId).toBe(7);
  });

  it("silently skips ltids that are not owned by the conversation", async () => {
    const removed: number[] = [];
    installChromeStub(removed);

    // ltid999 is registered with the registry but NEVER added to
    // conv-1's ownedLtids — closeOwnedTabs's defensive filter must
    // skip it, leaving only the legitimately-owned ltid101 closed.
    const ltid999 = tabRegistry.registerExisting(999);
    const { closeOwnedTabs } = await import("../tab-scoping");

    const undo = await closeOwnedTabs("conv-1", [ltid101, ltid999]);

    expect(removed).toEqual([101]); // ONLY 101 closed; 999 was filtered
    expect(undo.tabs.map((t) => t.url)).toEqual(["https://a.com/x"]);
    // 999 is NOT recorded as a closed tab in the conversation's owned
    // list because it was never owned in the first place.
    const conv = await chatDb.getConversation("conv-1");
    expect(conv?.ownedLtids).toEqual([ltid102]);
  });

  it("tolerates an owned tab whose ctid is already gone in chrome", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    // Override chrome.tabs.get for ctid 102 so it rejects (the tab is
    // gone), but leave 101 alive. Both are owned by conv-1.
    const prev = chrome.tabs.get;
    (chrome.tabs as { get: typeof prev }).get = (id: number) =>
      id === 102 ? Promise.reject(new Error("no tab")) : prev(id);

    const { closeOwnedTabs } = await import("../tab-scoping");

    const undo = await closeOwnedTabs("conv-1", [ltid101, ltid102]);

    // 101 closed cleanly; 102 was owned but the chrome.tabs.get rejected
    // so it's omitted from the undo (nothing to reopen) and chrome.tabs
    // .remove never fires for it. Both ltids are still removed from the
    // conversation's ownedLtids since they were both passed in.
    expect(removed).toEqual([101]);
    expect(undo.tabs.map((t) => t.url)).toEqual(["https://a.com/x"]);
    const conv = await chatDb.getConversation("conv-1");
    expect(conv?.ownedLtids).toEqual([]);
  });
});
