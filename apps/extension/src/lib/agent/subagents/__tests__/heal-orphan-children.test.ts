import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatDb } from "../../../chat-db";
import { createChildConversation } from "../child-conversation";
import {
  finalizeAllRunningChildrenAtStartup,
  finalizeOrphanedChildrenForHeals,
} from "../heal-orphan-children";

describe("heal-orphan-children", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();

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

  describe("finalizeOrphanedChildrenForHeals", () => {
    it("finalizes a running child row matching the parent toolCallId", async () => {
      const child = await createChildConversation({
        parentConversationId: "parent-1",
        slug: "general",
        isolation: "peer",
        title: "task",
        parentToolCallId: "toolu_abc",
      });

      await finalizeOrphanedChildrenForHeals({
        parentConversationId: "parent-1",
        healedDelegateToolCallIds: ["toolu_abc"],
      });

      const after = await chatDb.getConversation(child.id);
      expect(after?.subagentStatus).toBe("failed");
      expect(after?.subagentFinalText).toMatch(/interrupted/i);
    });

    it("is idempotent — finalizing twice keeps status at 'failed'", async () => {
      const child = await createChildConversation({
        parentConversationId: "parent-1",
        slug: "general",
        isolation: "peer",
        title: "task",
        parentToolCallId: "toolu_abc",
      });

      await finalizeOrphanedChildrenForHeals({
        parentConversationId: "parent-1",
        healedDelegateToolCallIds: ["toolu_abc"],
      });
      await finalizeOrphanedChildrenForHeals({
        parentConversationId: "parent-1",
        healedDelegateToolCallIds: ["toolu_abc"],
      });

      const after = await chatDb.getConversation(child.id);
      expect(after?.subagentStatus).toBe("failed");
    });

    it("does not touch child rows that already finished", async () => {
      const child = await createChildConversation({
        parentConversationId: "parent-1",
        slug: "general",
        isolation: "peer",
        title: "task",
        parentToolCallId: "toolu_abc",
      });
      await chatDb.updateConversation(child.id, {
        subagentStatus: "completed",
        subagentFinalText: "done",
      });

      await finalizeOrphanedChildrenForHeals({
        parentConversationId: "parent-1",
        healedDelegateToolCallIds: ["toolu_abc"],
      });

      const after = await chatDb.getConversation(child.id);
      // Status preserved; final text not overwritten.
      expect(after?.subagentStatus).toBe("completed");
      expect(after?.subagentFinalText).toBe("done");
    });

    it("ignores toolCallIds that don't map to any child row", async () => {
      // No child created — pretend we're on a pre-v12 row with no link.
      await expect(
        finalizeOrphanedChildrenForHeals({
          parentConversationId: "parent-1",
          healedDelegateToolCallIds: ["toolu_unknown"],
        }),
      ).resolves.toBeUndefined();
    });

    it("uses the supplied finalText override when provided", async () => {
      const child = await createChildConversation({
        parentConversationId: "parent-1",
        slug: "general",
        isolation: "peer",
        title: "task",
        parentToolCallId: "toolu_abc",
      });

      await finalizeOrphanedChildrenForHeals({
        parentConversationId: "parent-1",
        healedDelegateToolCallIds: ["toolu_abc"],
        finalText: "custom interruption text",
      });

      const after = await chatDb.getConversation(child.id);
      expect(after?.subagentFinalText).toBe("custom interruption text");
    });
  });

  describe("finalizeAllRunningChildrenAtStartup", () => {
    it("finalizes all running children regardless of parentToolCallId", async () => {
      // Two children — one with link, one without (pre-v12 simulation).
      const linked = await createChildConversation({
        parentConversationId: "parent-1",
        slug: "general",
        isolation: "peer",
        title: "linked",
        parentToolCallId: "toolu_abc",
      });
      const unlinked = await createChildConversation({
        parentConversationId: "parent-1",
        slug: "general",
        isolation: "peer",
        title: "unlinked",
      });

      const finalized = await finalizeAllRunningChildrenAtStartup();
      expect(finalized.sort()).toEqual([linked.id, unlinked.id].sort());

      const a = await chatDb.getConversation(linked.id);
      const b = await chatDb.getConversation(unlinked.id);
      expect(a?.subagentStatus).toBe("failed");
      expect(b?.subagentStatus).toBe("failed");
    });

    it("skips children that are already in a terminal state", async () => {
      const completed = await createChildConversation({
        parentConversationId: "parent-1",
        slug: "general",
        isolation: "peer",
        title: "done",
      });
      await chatDb.updateConversation(completed.id, {
        subagentStatus: "completed",
      });

      const finalized = await finalizeAllRunningChildrenAtStartup();
      expect(finalized).toEqual([]);

      const after = await chatDb.getConversation(completed.id);
      expect(after?.subagentStatus).toBe("completed");
    });

    it("uses the supplied finalText override when provided", async () => {
      const child = await createChildConversation({
        parentConversationId: "parent-1",
        slug: "general",
        isolation: "peer",
        title: "task",
      });

      await finalizeAllRunningChildrenAtStartup({
        finalText: "(extension reloaded)",
      });

      const after = await chatDb.getConversation(child.id);
      expect(after?.subagentFinalText).toBe("(extension reloaded)");
    });
  });
});
