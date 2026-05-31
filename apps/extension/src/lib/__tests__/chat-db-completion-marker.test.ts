import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatDb } from "../chat-db";

describe("chatDb completion marker fields", () => {
  beforeEach(() => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
  });
  afterEach(() => chatDb._resetForTests());

  it("persists lastCompletionApproved and taskCompletedAt", async () => {
    await chatDb.createConversation({
      id: "c1", title: "t", spaceId: null, ownedTabIds: [], createdAt: 0, updatedAt: 0,
    });
    await chatDb.updateConversation("c1", {
      lastCompletionApproved: true,
      taskCompletedAt: 1234,
    });
    const conv = await chatDb.getConversation("c1");
    expect(conv?.lastCompletionApproved).toBe(true);
    expect(conv?.taskCompletedAt).toBe(1234);
  });

  it("defaults to undefined on fresh conversations", async () => {
    await chatDb.createConversation({
      id: "c2", title: "t", spaceId: null, ownedTabIds: [], createdAt: 0, updatedAt: 0,
    });
    const conv = await chatDb.getConversation("c2");
    expect(conv?.lastCompletionApproved).toBeUndefined();
    expect(conv?.taskCompletedAt).toBeUndefined();
  });
});
