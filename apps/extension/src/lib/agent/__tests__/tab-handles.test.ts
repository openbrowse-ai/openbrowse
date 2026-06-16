import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../chat-db";
import {
  clearHandles,
  dropLtid,
  flushPersistsForTests,
  getOrCreateHandle,
  listHandles,
  loadHandlesForConversation,
  resolveHandle,
} from "../tab-handles";
import { tabRegistry, type LogicalTabId } from "../tab-registry";

const CONV_A = "conv-a";
const CONV_B = "conv-b";

async function seedConv(id: string, ownedLtids: LogicalTabId[] = []) {
  await chatDb.createConversation({
    id,
    title: id,
    spaceId: null,
    ownedLtids,
    createdAt: 0,
    updatedAt: 0,
  });
}

/**
 * Mint an ltid for a fake chrome tab id so tests can assert
 * (handle → ltid → ctid) round-trips. The registry's `registerExisting`
 * is idempotent, so duplicate calls return the same ltid.
 */
function ltidFor(ctid: number): LogicalTabId {
  return tabRegistry.registerExisting(ctid);
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
    tabRegistry.__resetForTests!();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    clearHandles(CONV_A);
    clearHandles(CONV_B);
    tabRegistry.__resetForTests!();
    vi.unstubAllGlobals();
  });

  describe("getOrCreateHandle", () => {
    it("returns t1, t2, ... for new ltids and is stable per (conversation, ltid)", async () => {
      await seedConv(CONV_A);
      const ltid100 = ltidFor(100);
      const ltid200 = ltidFor(200);
      expect(getOrCreateHandle(CONV_A, ltid100)).toBe("t1");
      expect(getOrCreateHandle(CONV_A, ltid200)).toBe("t2");
      expect(getOrCreateHandle(CONV_A, ltid100)).toBe("t1");
    });

    it("scopes counter independently per conversation", async () => {
      await seedConv(CONV_A);
      await seedConv(CONV_B);
      expect(getOrCreateHandle(CONV_A, ltidFor(100))).toBe("t1");
      expect(getOrCreateHandle(CONV_B, ltidFor(999))).toBe("t1");
      expect(getOrCreateHandle(CONV_A, ltidFor(200))).toBe("t2");
      expect(getOrCreateHandle(CONV_B, ltidFor(888))).toBe("t2");
    });
  });

  describe("resolveHandle", () => {
    it("round-trips a handle to its ltid", async () => {
      await seedConv(CONV_A);
      const ltid42 = ltidFor(42);
      getOrCreateHandle(CONV_A, ltid42);
      expect(resolveHandle(CONV_A, "t1")).toBe(ltid42);
    });

    it("returns undefined for unknown handle or unknown conversation", async () => {
      await seedConv(CONV_A);
      getOrCreateHandle(CONV_A, ltidFor(42));
      expect(resolveHandle(CONV_A, "t99")).toBeUndefined();
      expect(resolveHandle("nope", "t1")).toBeUndefined();
    });
  });

  describe("listHandles", () => {
    it("emits all live (handle, ltid) pairs", async () => {
      await seedConv(CONV_A);
      const ltid10 = ltidFor(10);
      const ltid20 = ltidFor(20);
      getOrCreateHandle(CONV_A, ltid10);
      getOrCreateHandle(CONV_A, ltid20);
      const list = listHandles(CONV_A).sort((a, b) =>
        a.handle.localeCompare(b.handle),
      );
      expect(list).toEqual([
        { handle: "t1", ltid: ltid10 },
        { handle: "t2", ltid: ltid20 },
      ]);
    });
  });

  describe("dropLtid", () => {
    it("removes the handle from every conversation that knew it", async () => {
      await seedConv(CONV_A);
      await seedConv(CONV_B);
      const ltid555 = ltidFor(555);
      getOrCreateHandle(CONV_A, ltid555);
      getOrCreateHandle(CONV_B, ltid555);

      dropLtid(ltid555);

      expect(resolveHandle(CONV_A, "t1")).toBeUndefined();
      expect(resolveHandle(CONV_B, "t1")).toBeUndefined();
    });

    it("is a no-op for unknown ltid", async () => {
      await seedConv(CONV_A);
      const ltid100 = ltidFor(100);
      getOrCreateHandle(CONV_A, ltid100);
      expect(() => dropLtid("nonexistent-ltid")).not.toThrow();
      expect(resolveHandle(CONV_A, "t1")).toBe(ltid100);
    });
  });

  describe("clearHandles", () => {
    it("drops the in-memory map but leaves persisted state intact", async () => {
      const ltid100 = ltidFor(100);
      await seedConv(CONV_A, [ltid100]);
      getOrCreateHandle(CONV_A, ltid100);
      await flushPersist();

      clearHandles(CONV_A);
      expect(resolveHandle(CONV_A, "t1")).toBeUndefined();

      // Hydration restores it. The registry still has ltid100 → 100, so
      // the persisted handle is resolvable.
      await loadHandlesForConversation(CONV_A);
      expect(resolveHandle(CONV_A, "t1")).toBe(ltid100);
    });
  });

  describe("persistence + hydration", () => {
    it("only persists handles for ltids in ownedLtids", async () => {
      const ltid100 = ltidFor(100);
      const ltid999 = ltidFor(999);
      await seedConv(CONV_A, [ltid100]);
      getOrCreateHandle(CONV_A, ltid100);
      getOrCreateHandle(CONV_A, ltid999); // ephemeral (e.g. a listTabs preview)
      await flushPersist();

      const conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState?.handles).toEqual({ t1: ltid100 });
      // counter still advances even for ephemeral handles
      expect(conv?.handleState?.counter).toBe(3);
    });

    it("re-persists when an ephemeral handle's ltid gets bound (selectTab flow)", async () => {
      const ltid555 = ltidFor(555);
      // Mint an ephemeral handle while ownedLtids is empty.
      await seedConv(CONV_A, []);
      getOrCreateHandle(CONV_A, ltid555);
      await flushPersist();

      // chatDb should not contain the unowned handle yet.
      let conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState?.handles).toEqual({});

      // Simulate selectTab binding ltid555 into ownedLtids.
      await chatDb.updateConversation(CONV_A, { ownedLtids: [ltid555] });

      // Re-call getOrCreateHandle for the same ltid. The function returns
      // the existing handle BUT must also schedule a fresh persist so the
      // now-owned handle lands in chatDb.
      const handle = getOrCreateHandle(CONV_A, ltid555);
      expect(handle).toBe("t1");
      await flushPersist();

      conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState?.handles).toEqual({ t1: ltid555 });
    });

    it("persists newly-minted handles to chatDb (owned tabs)", async () => {
      const ltid100 = ltidFor(100);
      const ltid200 = ltidFor(200);
      await seedConv(CONV_A, [ltid100, ltid200]);
      getOrCreateHandle(CONV_A, ltid100);
      getOrCreateHandle(CONV_A, ltid200);
      await flushPersist();

      const conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState).toBeDefined();
      expect(conv?.handleState?.handles).toEqual({ t1: ltid100, t2: ltid200 });
      expect(conv?.handleState?.counter).toBe(3);
    });

    it("restores counter so new handles don't collide with persisted ones", async () => {
      const ltid100 = ltidFor(100);
      const ltid200 = ltidFor(200);
      await seedConv(CONV_A, [ltid100, ltid200]);
      getOrCreateHandle(CONV_A, ltid100);
      getOrCreateHandle(CONV_A, ltid200);
      await flushPersist();

      // Simulate SW restart: in-memory map is cleared but chatDb survives.
      // Crucially we DO NOT reset the registry — in real life the v15
      // migration / SW startup pass would have re-registered the ctids
      // under the same ltids before tab-handles loads them.
      clearHandles(CONV_A);

      await loadHandlesForConversation(CONV_A);

      // Existing handles still resolve.
      expect(resolveHandle(CONV_A, "t1")).toBe(ltid100);
      expect(resolveHandle(CONV_A, "t2")).toBe(ltid200);

      // New ltid gets t3 (counter advanced past stored max).
      expect(getOrCreateHandle(CONV_A, ltidFor(300))).toBe("t3");
    });

    it("prunes ltids the registry can't resolve during hydration", async () => {
      const ltid100 = ltidFor(100);
      const ltid200 = ltidFor(200);
      const ltid300 = ltidFor(300);
      await seedConv(CONV_A, [ltid100, ltid200, ltid300]);
      getOrCreateHandle(CONV_A, ltid100);
      getOrCreateHandle(CONV_A, ltid200);
      getOrCreateHandle(CONV_A, ltid300);
      await flushPersist();

      clearHandles(CONV_A);

      // Tab 200 is dead — simulate by unregistering its ltid from the
      // registry. (In the real SW startup flow, only ctids that actually
      // resolved via chrome.tabs.query would have been re-registered.)
      tabRegistry.unregister(ltid200);

      await loadHandlesForConversation(CONV_A);

      expect(resolveHandle(CONV_A, "t1")).toBe(ltid100);
      expect(resolveHandle(CONV_A, "t2")).toBeUndefined();
      expect(resolveHandle(CONV_A, "t3")).toBe(ltid300);

      // Pruned snapshot is written back.
      await flushPersist();
      const conv = await chatDb.getConversation(CONV_A);
      expect(conv?.handleState?.handles).toEqual({
        t1: ltid100,
        t3: ltid300,
      });
    });

    it("repairs counter if chatDb stored an inconsistent (low) counter", async () => {
      const ltid999 = ltidFor(999);
      await seedConv(CONV_A, [ltid999]);
      // Manually corrupt: stored counter is 1 but max suffix is t5.
      await chatDb.updateConversation(CONV_A, {
        handleState: {
          handles: { t5: ltid999 },
          counter: 1,
        },
      });

      await loadHandlesForConversation(CONV_A);

      // Counter should advance past max seen suffix (5) → next handle is t6.
      expect(getOrCreateHandle(CONV_A, ltidFor(1000))).toBe("t6");
    });

    it("repairs counter if chatDb stored a non-finite value", async () => {
      await seedConv(CONV_A);
      await chatDb.updateConversation(CONV_A, {
        handleState: {
          handles: {},
          counter: Number.NaN,
        },
      });
      await loadHandlesForConversation(CONV_A);
      // Falls back to 1 (defensive), not NaN.
      expect(getOrCreateHandle(CONV_A, ltidFor(100))).toBe("t1");
    });

    it("treats a missing handleState as a fresh map", async () => {
      await seedConv(CONV_A);
      // No handleState written.
      await loadHandlesForConversation(CONV_A);
      expect(getOrCreateHandle(CONV_A, ltidFor(42))).toBe("t1");
    });

    it("hydration's merge keeps live handles when a name collision happens", async () => {
      const ltid100 = ltidFor(100);
      // Pre-populate chatDb as if a previous session had t1→ltid100 owned.
      await seedConv(CONV_A, [ltid100]);
      await chatDb.updateConversation(CONV_A, {
        handleState: { handles: { t1: ltid100 }, counter: 2 },
      });

      // Simulate the agent racing ahead and minting a handle for a
      // DIFFERENT ltid BEFORE hydration lands. The fresh map starts at
      // counter=1, so the freshly-minted handle for ltid200 will also be
      // "t1" — colliding with the persisted t1→ltid100. The merge must
      // keep the live binding (live wins), not silently overwrite it
      // with the stale persisted value.
      const ltid200 = ltidFor(200);
      const freshHandle = getOrCreateHandle(CONV_A, ltid200);
      expect(freshHandle).toBe("t1");

      await loadHandlesForConversation(CONV_A);

      // t1 still resolves to the live ltid the agent already minted (200),
      // not the stale persisted 100. The persisted entry is dropped on
      // collision because the live map's claim is authoritative.
      expect(resolveHandle(CONV_A, "t1")).toBe(ltid200);
    });

    it("hydration's merge restores persisted handles when there's no live conflict", async () => {
      const ltid100 = ltidFor(100);
      await seedConv(CONV_A, [ltid100]);
      await chatDb.updateConversation(CONV_A, {
        handleState: { handles: { t1: ltid100 }, counter: 2 },
      });
      // Realistic flow: hydration completes BEFORE any handles are minted.
      await loadHandlesForConversation(CONV_A);
      expect(resolveHandle(CONV_A, "t1")).toBe(ltid100);
      // Counter advanced; new ltid gets t2.
      expect(getOrCreateHandle(CONV_A, ltidFor(200))).toBe("t2");
    });
  });

  describe("registry integration", () => {
    it("dropLtid fires when the registry emits onRemove", async () => {
      const ltid100 = ltidFor(100);
      await seedConv(CONV_A, [ltid100]);
      getOrCreateHandle(CONV_A, ltid100);
      expect(resolveHandle(CONV_A, "t1")).toBe(ltid100);

      // Drive the registry's onRemove via its test seam.
      tabRegistry.__handleRemoveForTests!(100);

      expect(resolveHandle(CONV_A, "t1")).toBeUndefined();
    });

    it("does NOT mutate the handle map on registry onReplace (ltid is stable)", async () => {
      const ltid100 = ltidFor(100);
      await seedConv(CONV_A, [ltid100]);
      getOrCreateHandle(CONV_A, ltid100);
      const beforeT1 = resolveHandle(CONV_A, "t1");
      expect(beforeT1).toBe(ltid100);

      // Drive an onReplace: ctid 100 → 200. Same ltid, different ctid.
      tabRegistry.__handleReplaceForTests!(200, 100);

      // Handle map is unchanged: t1 still resolves to the same ltid.
      expect(resolveHandle(CONV_A, "t1")).toBe(ltid100);
      // And the ltid now resolves to ctid 200 in the registry.
      expect(tabRegistry.toChromeTabId(ltid100)).toBe(200);
    });
  });
});
