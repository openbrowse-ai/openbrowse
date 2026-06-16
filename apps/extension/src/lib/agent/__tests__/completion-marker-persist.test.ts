import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatDb } from "../../chat-db";
import { persistCompletionMarker } from "../persist-completion-marker";

describe("persistCompletionMarker", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    await chatDb.createConversation({
      id: "c1", title: "t", spaceId: null, ownedLtids: [], createdAt: 0, updatedAt: 0,
    });
  });
  afterEach(() => chatDb._resetForTests());

  it("sets lastCompletionApproved + taskCompletedAt on approved", async () => {
    await persistCompletionMarker("c1", "approved", 5000);
    const conv = await chatDb.getConversation("c1");
    expect(conv?.lastCompletionApproved).toBe(true);
    expect(conv?.taskCompletedAt).toBe(5000);
  });

  it("does nothing for non-approved outcomes", async () => {
    await persistCompletionMarker("c1", "force-emitted", 5000);
    await persistCompletionMarker("c1", "skipped", 5000);
    await persistCompletionMarker("c1", "rejected", 5000);
    const conv = await chatDb.getConversation("c1");
    expect(conv?.lastCompletionApproved).toBeUndefined();
    expect(conv?.taskCompletedAt).toBeUndefined();
  });

  it("is a no-op for an unknown conversation", async () => {
    await expect(persistCompletionMarker("nope", "approved", 1)).resolves.toBeUndefined();
  });
});
