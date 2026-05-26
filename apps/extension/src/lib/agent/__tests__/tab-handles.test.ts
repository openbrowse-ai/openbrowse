import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../chat-db";
import {
  clearHandles,
  dropTab,
  flushPersistsForTests,
  getOrCreateHandle,
  listHandles,
  loadHandlesForConversation,
  resolveHandle,
} from "../tab-handles";

const CONV_A = "conv-a";
const CONV_B = "conv-b";

async function seedConv(id: string, ownedTabIds: number[] = []) {
  await chatDb.createConversation({
    id,
    title: id,
    spaceId: null,
    ownedTabIds,
    createdAt: 0,
    updatedAt: 0,
  });
}

/**
 * Deterministic flush of pending persistence writes for a conversation.
 * Replaces a previous timing-based helper that was flaky under load.
 */
async function flushPersist(convId: string = CONV_A) {
  await flushPersistsForTests(convId);
}

describe("tab-handles", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    clearHandles(CONV_A);
    clearHandles(CONV_B);
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    clearHandles(CONV_A);
    clearHandles(CONV_B);
    vi.unstubAllGlobals();
  });

  describe("getOrCreateHandle", () => {
    it("returns t1, t2, ... for new tabs and is stable per (conversation, tabId)", async () => {
      await seedConv(CONV_A);
      expect(getOrCreateHandle(CONV_A, 100)).toBe("t1");
      expect(getOrCreateHandle(CONV_A, 200)).toBe("t2");
      expect(getOrCreateHandle(CONV_A, 100)).toBe("t1");
    });

    it("scopes counter independently per conversation", async () => {
      await seedConv(CONV_A);
      await seedConv(CONV_B);
      expect(getOrCreateHandle(CONV_A, 100)).toBe("t1");
      expect(getOrCreateHandle(CONV_B, 999)).toBe("t1");
      expect(getOrCreateHandle(CONV_A, 200)).toBe("t2");
      expect(getOrCreateHandle(CONV_B, 888)).toBe("t2");
    });
  });

  describe("resolveHandle", () => {
    it("round-trips a handle to its tabId", async () => {
      await seedConv(CONV_A);
      getOrCreateHandle(CONV_A, 42);
      expect(resolveHandle(CONV_A, "t1")).toBe(42);
    });

    it("returns undefined for unknown handle or unknown conversation", async () => {
      await seedConv(CONV_A);
      getOrCreateHandle(CONV_A, 42);
      expect(resolveHandle(CONV_A, "t99")).toBeUndefined();
      expect(resolveHandle("nope", "t1")).toBeUndefined();
    });
  });

  describe("listHandles", () => {
    it("emits all live (handle, tabId) pairs", async () => {
      await seedConv(CONV_A);
      getOrCreateHandle(CONV_A, 10);
      getOrCreateHandle(CONV_A, 20);
      const list = listHandles(CONV_A).sort((a, b) =>
        a.handle.localeCompare(b.handle),
      );
      expect(list).toEqual([
        { handle: "t1", tabId: 10 },
        { handle: "t2", tabId: 20 },
      ]);
    });
  });

  describe("dropTab", () => {
    it("removes the handle from every conversation that knew it", async () => {
      await seedConv(CONV_A);
      await seedConv(CONV_B);
      getOrCreateHandle(CONV_A, 555);
      getOrCreateHandle(CONV_B, 555);

      dropTab(555);

      expect(resolveHandle(CONV_A, "t1")).toBeUndefined();
      expect(resolveHandle(CONV_B, "t1")).toBeUndefined();
    });

    it("is a no-op for unknown tab", async () => {
      await seedConv(CONV_A);
      getOrCreateHandle(CONV_A, 100);
      expect(() => dropTab(99999)).not.toThrow();
      expect(resolveHandle(CONV_A, "t1")).toBe(100);
    });
  });

  describe("clearHandles", () => {
    it("drops the in-memory map but leaves persisted state intact", async () => {
      await seedConv(CONV_A, [100]);
      getOrCreateHandle(CONV_A, 100);
      await flushPersist();

      clearHandles(CONV_A);
      expect(resolveHandle(CONV_A, "t1")).toBeUndefined();

      // Hydration restores it. Stub chrome so the tab is reported live.
      vi.stubGlobal("chrome", {
        tabs: { get: vi.fn(async () => ({} as chrome.tabs.Tab)) },
      });
      await loadHandlesForConversation(CONV_A);
      expect(resolveHandle(CONV_A, "t1")).toBe(100);
    });
  });

  describe("persistence + hydration", () => {
    it("only persists handles for tabs in ownedTabIds", async () => {
      // Seed with 100 owned, 999 unowned.
      await seedConv(CONV_A, [100]);
      getOrCreateHandle(CONV_A, 100);
      getOrCreateHandle(CONV_A, 999); // ephemeral (e.g. a listTabs preview)
      await flushPersist();

      const conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState?.handles).toEqual({ t1: 100 });
      // counter still advances even for ephemeral handles
      expect(conv?.handleState?.counter).toBe(3);
    });

    it("re-persists when an ephemeral handle's tab gets bound (selectTab flow)", async () => {
      // Mint an ephemeral handle while ownedTabIds is empty.
      await seedConv(CONV_A, []);
      getOrCreateHandle(CONV_A, 555);
      await flushPersist();

      // chatDb should not contain the unowned handle yet.
      let conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState?.handles).toEqual({});

      // Simulate selectTab binding 555 into ownedTabIds.
      await chatDb.updateConversation(CONV_A, { ownedTabIds: [555] });

      // Re-call getOrCreateHandle for the same tabId. The function returns
      // the existing handle BUT must also schedule a fresh persist so the
      // now-owned handle lands in chatDb.
      const handle = getOrCreateHandle(CONV_A, 555);
      expect(handle).toBe("t1");
      await flushPersist();

      conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState?.handles).toEqual({ t1: 555 });
    });

    it("persists newly-minted handles to chatDb (owned tabs)", async () => {
      await seedConv(CONV_A, [100, 200]);
      getOrCreateHandle(CONV_A, 100);
      getOrCreateHandle(CONV_A, 200);
      await flushPersist();

      const conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState).toBeDefined();
      expect(conv?.handleState?.handles).toEqual({ t1: 100, t2: 200 });
      expect(conv?.handleState?.counter).toBe(3);
    });

    it("restores counter so new handles don't collide with persisted ones", async () => {
      await seedConv(CONV_A, [100, 200]);
      getOrCreateHandle(CONV_A, 100);
      getOrCreateHandle(CONV_A, 200);
      await flushPersist();

      // Simulate SW restart: in-memory map is cleared but chatDb survives.
      clearHandles(CONV_A);

      // `chrome.tabs.get` available → all persisted tabs are reported live.
      vi.stubGlobal("chrome", {
        tabs: {
          get: vi.fn(async () => ({} as chrome.tabs.Tab)),
        },
      });

      await loadHandlesForConversation(CONV_A);

      // Existing handles still resolve.
      expect(resolveHandle(CONV_A, "t1")).toBe(100);
      expect(resolveHandle(CONV_A, "t2")).toBe(200);

      // New tab gets t3 (counter advanced past stored max).
      expect(getOrCreateHandle(CONV_A, 300)).toBe("t3");
    });

    it("prunes dead tabs during hydration", async () => {
      await seedConv(CONV_A, [100, 200, 300]);
      getOrCreateHandle(CONV_A, 100);
      getOrCreateHandle(CONV_A, 200);
      getOrCreateHandle(CONV_A, 300);
      await flushPersist();

      clearHandles(CONV_A);

      // Tab 200 is dead.
      vi.stubGlobal("chrome", {
        tabs: {
          get: vi.fn(async (id: number) => {
            if (id === 200) throw new Error("No tab with id 200");
            return {} as chrome.tabs.Tab;
          }),
        },
      });

      await loadHandlesForConversation(CONV_A);

      expect(resolveHandle(CONV_A, "t1")).toBe(100);
      expect(resolveHandle(CONV_A, "t2")).toBeUndefined();
      expect(resolveHandle(CONV_A, "t3")).toBe(300);

      // Pruned snapshot is written back.
      await flushPersist();
      const conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState?.handles).toEqual({ t1: 100, t3: 300 });
    });

    it("repairs counter if chatDb stored an inconsistent (low) counter", async () => {
      await seedConv(CONV_A, [999]);
      // Manually corrupt: stored counter is 1 but max suffix is t5.
      await chatDb.updateConversation(CONV_A, {
        handleState: {
          handles: { t5: 999 },
          counter: 1,
        },
      });

      vi.stubGlobal("chrome", {
        tabs: { get: vi.fn(async () => ({} as chrome.tabs.Tab)) },
      });

      await loadHandlesForConversation(CONV_A);

      // Counter should advance past max seen suffix (5) → next handle is t6.
      expect(getOrCreateHandle(CONV_A, 1000)).toBe("t6");
    });

    it("repairs counter if chatDb stored a non-finite value", async () => {
      await seedConv(CONV_A);
      await chatDb.updateConversation(CONV_A, {
        handleState: {
          handles: {},
          counter: Number.NaN,
        },
      });
      vi.stubGlobal("chrome", {
        tabs: { get: vi.fn(async () => ({} as chrome.tabs.Tab)) },
      });
      await loadHandlesForConversation(CONV_A);
      // Falls back to 1 (defensive), not NaN.
      expect(getOrCreateHandle(CONV_A, 100)).toBe("t1");
    });

    it("treats a missing handleState as a fresh map", async () => {
      await seedConv(CONV_A);
      // No handleState written.
      await loadHandlesForConversation(CONV_A);
      expect(getOrCreateHandle(CONV_A, 42)).toBe("t1");
    });

    it("hydration's merge keeps live handles when a name collision happens", async () => {
      // Pre-populate chatDb as if a previous session had t1→100 owned.
      await seedConv(CONV_A, [100]);
      await chatDb.updateConversation(CONV_A, {
        handleState: { handles: { t1: 100 }, counter: 2 },
      });

      // Stub chrome so hydration's liveness check passes for any id.
      vi.stubGlobal("chrome", {
        tabs: { get: vi.fn(async () => ({} as chrome.tabs.Tab)) },
      });

      // Simulate the agent racing ahead and minting a handle BEFORE hydration
      // lands. The fresh map starts at counter=1, so the freshly-minted
      // handle for tabId=200 will also be "t1" — colliding with the
      // persisted t1→100. The merge must keep the live binding (live wins),
      // not silently overwrite it with the stale persisted value.
      const freshHandle = getOrCreateHandle(CONV_A, 200);
      expect(freshHandle).toBe("t1");

      await loadHandlesForConversation(CONV_A);

      // t1 still resolves to the live tab the agent already minted (200),
      // not the stale persisted 100. The persisted entry is dropped on
      // collision because the live map's claim is authoritative.
      expect(resolveHandle(CONV_A, "t1")).toBe(200);
    });

    it("hydration's merge restores persisted handles when there's no live conflict", async () => {
      await seedConv(CONV_A, [100]);
      await chatDb.updateConversation(CONV_A, {
        handleState: { handles: { t1: 100 }, counter: 2 },
      });
      vi.stubGlobal("chrome", {
        tabs: { get: vi.fn(async () => ({} as chrome.tabs.Tab)) },
      });
      // Realistic flow: hydration completes BEFORE any handles are minted.
      await loadHandlesForConversation(CONV_A);
      expect(resolveHandle(CONV_A, "t1")).toBe(100);
      // Counter advanced; new tab gets t2.
      expect(getOrCreateHandle(CONV_A, 200)).toBe("t2");
    });
  });
});
