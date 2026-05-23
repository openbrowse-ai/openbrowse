import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queueDb, subscribeQueueChange } from "../queue-db";
import type { QueuedMessage } from "../types";

function makeItem(
  conversationId: string,
  id: string,
  text: string,
  createdAt: number,
): QueuedMessage {
  return {
    id,
    conversationId,
    text,
    mentionContext: "",
    attachmentBlock: "",
    visionFiles: [],
    createdAt,
  };
}

describe("queue-db", () => {
  beforeEach(async () => {
    // Reset both fake IndexedDB and the cached connection so each test
    // starts from an empty database.
    indexedDB = new IDBFactory();
    queueDb._resetForTests();
  });

  afterEach(() => {
    queueDb._resetForTests();
  });

  describe("enqueue/list", () => {
    it("returns items sorted by createdAt for the requested conversation only", async () => {
      const convA = "conv-a";
      const convB = "conv-b";
      await queueDb.enqueue(makeItem(convA, "a1", "first", 100));
      await queueDb.enqueue(makeItem(convA, "a3", "third", 300));
      await queueDb.enqueue(makeItem(convA, "a2", "second", 200));
      await queueDb.enqueue(makeItem(convB, "b1", "other", 150));

      const items = await queueDb.list(convA);
      expect(items.map((i) => i.id)).toEqual(["a1", "a2", "a3"]);

      const otherItems = await queueDb.list(convB);
      expect(otherItems.map((i) => i.id)).toEqual(["b1"]);
    });
  });

  describe("update", () => {
    it("merges patch fields and leaves others intact", async () => {
      const conv = "c1";
      await queueDb.enqueue(makeItem(conv, "i1", "before", 100));
      await queueDb.update("i1", { text: "after", mentionContext: "ctx" });
      const [item] = await queueDb.list(conv);
      expect(item.text).toBe("after");
      expect(item.mentionContext).toBe("ctx");
      expect(item.createdAt).toBe(100);
    });

    it("is a no-op for an unknown id", async () => {
      await queueDb.update("ghost", { text: "x" });
      const items = await queueDb.list("anywhere");
      expect(items).toEqual([]);
    });
  });

  describe("remove/clear", () => {
    it("removes a single item", async () => {
      const conv = "c1";
      await queueDb.enqueue(makeItem(conv, "i1", "a", 100));
      await queueDb.enqueue(makeItem(conv, "i2", "b", 200));
      await queueDb.remove("i1");
      const items = await queueDb.list(conv);
      expect(items.map((i) => i.id)).toEqual(["i2"]);
    });

    it("clears all items for a conversation but leaves others", async () => {
      await queueDb.enqueue(makeItem("a", "a1", "x", 100));
      await queueDb.enqueue(makeItem("a", "a2", "y", 200));
      await queueDb.enqueue(makeItem("b", "b1", "z", 100));
      await queueDb.clear("a");
      expect(await queueDb.list("a")).toEqual([]);
      expect((await queueDb.list("b")).map((i) => i.id)).toEqual(["b1"]);
    });
  });

  describe("claimHead/releaseHead", () => {
    it("returns null on an empty queue", async () => {
      expect(await queueDb.claimHead("empty")).toBeNull();
    });

    it("returns the oldest item and locks the conversation", async () => {
      const conv = "c1";
      await queueDb.enqueue(makeItem(conv, "i2", "second", 200));
      await queueDb.enqueue(makeItem(conv, "i1", "first", 100));
      const claimed = await queueDb.claimHead(conv);
      expect(claimed?.id).toBe("i1");

      // A second concurrent claimer must back off until the first releases.
      const reentrant = await queueDb.claimHead(conv);
      expect(reentrant).toBeNull();
    });

    it("on success-release removes the item AND lets the next claim proceed", async () => {
      const conv = "c1";
      await queueDb.enqueue(makeItem(conv, "i1", "first", 100));
      await queueDb.enqueue(makeItem(conv, "i2", "second", 200));
      const claimed = await queueDb.claimHead(conv);
      expect(claimed?.id).toBe("i1");
      await queueDb.releaseHead(conv, "i1", true);

      const remaining = await queueDb.list(conv);
      expect(remaining.map((i) => i.id)).toEqual(["i2"]);

      const next = await queueDb.claimHead(conv);
      expect(next?.id).toBe("i2");
    });

    it("on failure-release keeps the item and frees the lock for retry", async () => {
      const conv = "c1";
      await queueDb.enqueue(makeItem(conv, "i1", "first", 100));
      const claimed = await queueDb.claimHead(conv);
      expect(claimed?.id).toBe("i1");
      await queueDb.releaseHead(conv, "i1", false);

      const items = await queueDb.list(conv);
      expect(items.map((i) => i.id)).toEqual(["i1"]);

      const reclaimed = await queueDb.claimHead(conv);
      expect(reclaimed?.id).toBe("i1");
    });

    it("ignores release calls from a stale claimer", async () => {
      const conv = "c1";
      await queueDb.enqueue(makeItem(conv, "i1", "first", 100));
      await queueDb.claimHead(conv);
      // Some other actor with a stale id calls release — must not unlock.
      await queueDb.releaseHead(conv, "different-id", true);
      const blocked = await queueDb.claimHead(conv);
      expect(blocked).toBeNull();
    });
  });

  describe("subscribeQueueChange (in-process pubsub)", () => {
    it("fires the local listener on enqueue/remove/update/clear", async () => {
      const listener = vi.fn();
      const unsub = subscribeQueueChange(listener);

      await queueDb.enqueue(makeItem("c1", "i1", "a", 100));
      expect(listener).toHaveBeenLastCalledWith("c1");

      await queueDb.update("i1", { text: "b" });
      expect(listener).toHaveBeenLastCalledWith("c1");

      await queueDb.remove("i1");
      expect(listener).toHaveBeenLastCalledWith("c1");

      await queueDb.enqueue(makeItem("c2", "i2", "x", 200));
      expect(listener).toHaveBeenLastCalledWith("c2");

      await queueDb.clear("c2");
      expect(listener).toHaveBeenLastCalledWith("c2");

      // 5 mutations should have produced 5 notifications.
      expect(listener).toHaveBeenCalledTimes(5);

      unsub();
    });

    it("fires on releaseHead so callers refresh after a flush", async () => {
      const listener = vi.fn();
      const unsub = subscribeQueueChange(listener);
      try {
        await queueDb.enqueue(makeItem("c1", "i1", "a", 100));
        listener.mockClear();
        await queueDb.claimHead("c1");
        await queueDb.releaseHead("c1", "i1", true);
        expect(listener).toHaveBeenCalledWith("c1");
      } finally {
        unsub();
      }
    });

    it("supports multiple concurrent listeners", async () => {
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = subscribeQueueChange(a);
      const unsubB = subscribeQueueChange(b);
      try {
        await queueDb.enqueue(makeItem("c1", "i1", "a", 100));
        expect(a).toHaveBeenCalledWith("c1");
        expect(b).toHaveBeenCalledWith("c1");
      } finally {
        unsubA();
        unsubB();
      }
    });

    it("stops firing after unsubscribe", async () => {
      const listener = vi.fn();
      const unsub = subscribeQueueChange(listener);
      await queueDb.enqueue(makeItem("c1", "i1", "a", 100));
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      await queueDb.enqueue(makeItem("c1", "i2", "b", 200));
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("isolates throwing listeners from other listeners", async () => {
      const good = vi.fn();
      const bad = vi.fn(() => {
        throw new Error("boom");
      });
      const unsubBad = subscribeQueueChange(bad);
      const unsubGood = subscribeQueueChange(good);
      try {
        // Mutation must succeed even if a listener throws.
        await queueDb.enqueue(makeItem("c1", "i1", "a", 100));
        expect(bad).toHaveBeenCalled();
        expect(good).toHaveBeenCalled();
        expect(await queueDb.list("c1")).toHaveLength(1);
      } finally {
        unsubBad();
        unsubGood();
      }
    });
  });
});
