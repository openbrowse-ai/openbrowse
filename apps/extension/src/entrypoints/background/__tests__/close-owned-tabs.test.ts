import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";

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
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onActivated: { addListener: () => {}, removeListener: () => {} },
    },
    tabGroups: { onRemoved: { addListener: () => {} }, TAB_GROUP_ID_NONE: -1 },
    storage: { session: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  });
}

describe("closeOwnedTabs", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    await chatDb.createConversation({
      id: "conv-1",
      title: "t",
      spaceId: null,
      ownedGroupId: 7,
      ownedTabIds: [101, 102],
      createdAt: 0,
      updatedAt: 0,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    chatDb._resetForTests();
  });

  it("removes the given tabs, returns an undo payload, and clears ownership", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    const { closeOwnedTabs } = await import("../tab-scoping");

    const undo = await closeOwnedTabs("conv-1", [101, 102]);

    expect(removed.sort()).toEqual([101, 102]);
    expect(undo.action).toBe("reopen");
    expect(undo.tabs).toEqual([
      { url: "https://a.com/x", windowId: 1, pinned: false },
      { url: "https://b.com/y", windowId: 1, pinned: false },
    ]);
    const conv = await chatDb.getConversation("conv-1");
    expect(conv?.ownedTabIds).toEqual([]);
  });

  it("nulls ownedGroupId when all owned tabs are closed", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    const { closeOwnedTabs } = await import("../tab-scoping");

    await closeOwnedTabs("conv-1", [101, 102]);

    const conv = await chatDb.getConversation("conv-1");
    expect(conv?.ownedGroupId).toBeNull();
  });

  it("keeps ownedGroupId and remaining tab when only some are closed", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    const { closeOwnedTabs } = await import("../tab-scoping");

    await closeOwnedTabs("conv-1", [101]);

    const conv = await chatDb.getConversation("conv-1");
    expect(conv?.ownedTabIds).toEqual([102]);
    expect(conv?.ownedGroupId).toBe(7);
  });

  it("tolerates a tab that is already gone", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    const prev = chrome.tabs.get;
    (chrome.tabs as { get: typeof prev }).get = (id: number) =>
      id === 999 ? Promise.reject(new Error("no tab")) : prev(id);
    const { closeOwnedTabs } = await import("../tab-scoping");

    const undo = await closeOwnedTabs("conv-1", [101, 999]);

    expect(removed).toContain(101);
    expect(undo.tabs.map((t) => t.url)).toEqual(["https://a.com/x"]);
  });
});
