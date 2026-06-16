import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import { tabRegistry } from "@/lib/agent/tab-registry";

const NOW = 10_000_000;

function installChromeStub(removed: number[], sent: any[] = []) {
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      sendMessage: (msg: any) => { sent.push(msg); return Promise.resolve({ ok: true }); },
      lastError: undefined,
    },
    tabs: {
      get: (id: number) => Promise.resolve({ id, url: `https://x/${id}`, title: "x", windowId: 1, pinned: false } as chrome.tabs.Tab),
      remove: (ids: number | number[]) => {
        (Array.isArray(ids) ? ids : [ids]).forEach((i) => removed.push(i));
        return Promise.resolve();
      },
      query: () => Promise.resolve([]),
      ungroup: () => Promise.reject(new Error("ungroup must not be called")),
      onRemoved: { addListener: () => {} },
      onReplaced: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onActivated: { addListener: () => {} },
    },
    tabGroups: { onRemoved: { addListener: () => {} }, TAB_GROUP_ID_NONE: -1 },
    storage: { session: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  });
}

let ltid101: string;
let ltid102: string;

async function seed(id: string, fields: Record<string, unknown>) {
  // Mint ltids for the fixture's two ctids in the registry so
  // cleanupCompletedAgentTabs can resolve them via tabRegistry.
  ltid101 = tabRegistry.registerExisting(101);
  ltid102 = tabRegistry.registerExisting(102);
  await chatDb.createConversation({
    id, title: id, spaceId: null, ownedGroupId: 1,
    ownedLtids: [ltid101, ltid102],
    createdAt: 0, updatedAt: 0,
  });
  await chatDb.updateConversation(id, fields);
}

describe("cleanupCompletedAgentTabs", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    chatDb._resetForTests();
    tabRegistry.__resetForTests!();
  });

  it("closes tabs for a completed, idle conversation when enabled", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    await seed("c1", { lastCompletionApproved: true, taskCompletedAt: NOW - 31 * 60_000 });
    const { cleanupCompletedAgentTabs } = await import("../tab-scoping");
    const closed = await cleanupCompletedAgentTabs({ enabled: true, timeoutMinutes: 30 });
    expect(closed).toBe(1);
    expect(removed.sort()).toEqual([101, 102]);
  });

  it("does nothing when the toggle is off", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    await seed("c1", { lastCompletionApproved: true, taskCompletedAt: NOW - 31 * 60_000 });
    const { cleanupCompletedAgentTabs } = await import("../tab-scoping");
    const closed = await cleanupCompletedAgentTabs({ enabled: false, timeoutMinutes: 30 });
    expect(closed).toBe(0);
    expect(removed).toEqual([]);
  });

  it("does nothing when not yet idle past timeout", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    await seed("c1", { lastCompletionApproved: true, taskCompletedAt: NOW - 10 * 60_000 });
    const { cleanupCompletedAgentTabs } = await import("../tab-scoping");
    const closed = await cleanupCompletedAgentTabs({ enabled: true, timeoutMinutes: 30 });
    expect(closed).toBe(0);
    expect(removed).toEqual([]);
  });

  it("does nothing for conversations that never completed", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    await seed("c1", { taskCompletedAt: NOW - 31 * 60_000 });
    const { cleanupCompletedAgentTabs } = await import("../tab-scoping");
    const closed = await cleanupCompletedAgentTabs({ enabled: true, timeoutMinutes: 30 });
    expect(closed).toBe(0);
    expect(removed).toEqual([]);
  });

  it("guards against NaN/non-positive timeout (treats as not-eligible)", async () => {
    const removed: number[] = [];
    installChromeStub(removed);
    await seed("c1", { lastCompletionApproved: true, taskCompletedAt: NOW - 100 * 60_000 });
    const { cleanupCompletedAgentTabs } = await import("../tab-scoping");
    const closed = await cleanupCompletedAgentTabs({ enabled: true, timeoutMinutes: Number.NaN });
    expect(closed).toBe(0);
    expect(removed).toEqual([]);
  });

  it("broadcasts an AGENT_TABS_CLOSED undo toast after closing", async () => {
    const removed: number[] = [];
    const sent: any[] = [];
    installChromeStub(removed, sent);
    await seed("c1", { lastCompletionApproved: true, taskCompletedAt: NOW - 31 * 60_000 });
    const { cleanupCompletedAgentTabs } = await import("../tab-scoping");
    await cleanupCompletedAgentTabs({ enabled: true, timeoutMinutes: 30 });
    const toast = sent.find((m) => m?.type === "AGENT_TABS_CLOSED");
    expect(toast).toBeTruthy();
    expect(toast.undo.action).toBe("reopen");
    expect(toast.conversationId).toBe("c1");
  });
});
