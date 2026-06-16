import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import { tabRegistry } from "@/lib/agent/tab-registry";

function installChromeStub(removed: number[]) {
  vi.stubGlobal("chrome", {
    runtime: { id: "test", sendMessage: () => Promise.resolve({ ok: true }), lastError: undefined },
    tabs: {
      get: (id: number) =>
        Promise.resolve({ id, url: `https://x/${id}`, title: "x", windowId: 1, pinned: false } as chrome.tabs.Tab),
      remove: (ids: number | number[]) => {
        (Array.isArray(ids) ? ids : [ids]).forEach((i) => removed.push(i));
        return Promise.resolve();
      },
      query: () => Promise.resolve([]),
      onRemoved: { addListener: () => {} },
      onReplaced: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
    },
    tabGroups: { onRemoved: { addListener: () => {} }, TAB_GROUP_ID_NONE: -1 },
    storage: { session: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  });
}

describe("handleCloseAgentTabs", () => {
  let ltid11: string;
  let ltid22: string;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
    ltid11 = tabRegistry.registerExisting(11);
    ltid22 = tabRegistry.registerExisting(22);
    await chatDb.createConversation({
      id: "c1", title: "t", spaceId: null, ownedGroupId: 3,
      ownedLtids: [ltid11, ltid22],
      createdAt: 0, updatedAt: 0,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
  });

  it("closes the group's tabs and returns undo", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    const { handleCloseAgentTabs } = await import("../close-agent-tabs");
    const res = await handleCloseAgentTabs({ conversationId: "c1", ltids: [ltid11, ltid22] });
    expect(res.ok).toBe(true);
    expect(removed.sort()).toEqual([11, 22]);
    expect(res.undo?.action).toBe("reopen");
  });

  it("returns ok:false on empty ltids", async () => {
    installChromeStub([]);
    const { handleCloseAgentTabs } = await import("../close-agent-tabs");
    const res = await handleCloseAgentTabs({ conversationId: "c1", ltids: [] });
    expect(res.ok).toBe(false);
  });
});
