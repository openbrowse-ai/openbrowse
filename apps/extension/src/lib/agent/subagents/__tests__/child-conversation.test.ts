import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatDb } from "../../../chat-db";
import {
  createChildConversation,
  finalizeChildConversation,
} from "../child-conversation";

describe("child-conversation helpers", () => {
  beforeEach(async () => {
    // Fresh DB per test.
    indexedDB = new IDBFactory();
    chatDb._resetForTests();

    // Seed a parent conversation.
    await chatDb.createConversation({
      id: "parent-1",
      title: "Parent",
      spaceId: "space-A",
      createdAt: 100,
      updatedAt: 100,
    });
  });

  afterEach(() => {
    chatDb._resetForTests();
  });

  it("creates a child conversation linked to its parent", async () => {
    const child = await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "summarize page",
    });

    const stored = await chatDb.getConversation(child.id);
    expect(stored).toBeDefined();
    expect(stored).toMatchObject({
      id: child.id,
      title: "summarize page",
      parentConversationId: "parent-1",
      subagentSlug: "explore",
      isolationProfile: "peer",
      subagentStatus: "running",
      // Inherits parent's space.
      spaceId: "space-A",
      ownedTabIds: [],
      ownedGroupId: null,
    });
  });

  it("listChildren returns only direct children", async () => {
    const a = await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "task A",
    });
    const b = await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "task B",
    });

    const children = await chatDb.listChildren("parent-1");
    expect(children.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("finalizeChildConversation writes the summary and final status", async () => {
    const child = await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "task",
    });

    await finalizeChildConversation({
      childConversationId: child.id,
      status: "completed",
      finalText: "found 5 products",
    });

    const stored = await chatDb.getConversation(child.id);
    expect(stored?.subagentStatus).toBe("completed");
    expect(stored?.subagentFinalText).toBe("found 5 products");
  });

  it("finalizeChildConversation handles failure status with error context", async () => {
    const child = await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "task",
    });

    await finalizeChildConversation({
      childConversationId: child.id,
      status: "failed",
      finalText: "(failed)",
    });

    const stored = await chatDb.getConversation(child.id);
    expect(stored?.subagentStatus).toBe("failed");
  });

  it("persists parentToolCallId when supplied so heal can locate the row", async () => {
    const child = await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "task",
      parentToolCallId: "toolu_call_abc123",
    });

    const stored = await chatDb.getConversation(child.id);
    expect(stored?.parentToolCallId).toBe("toolu_call_abc123");

    const found = await chatDb.findChildByParentToolCallId(
      "parent-1",
      "toolu_call_abc123",
    );
    expect(found?.id).toBe(child.id);
  });

  it("findChildByParentToolCallId returns undefined for unknown id", async () => {
    await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "task",
      parentToolCallId: "toolu_call_abc123",
    });

    const found = await chatDb.findChildByParentToolCallId(
      "parent-1",
      "toolu_call_does_not_exist",
    );
    expect(found).toBeUndefined();
  });
});
