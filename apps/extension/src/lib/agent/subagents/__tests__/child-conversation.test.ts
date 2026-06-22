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
      ownedLtids: [],
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

  it("inherits parent's mode and plan (security: user contract binds transitively)", async () => {
    // Update parent to Plan mode with an approved plan. The child must
    // inherit BOTH so the user-approved approval bounds bind across
    // delegations — otherwise a subagent silently reverts to default
    // Ask mode (or worse, would skip approvals the parent wouldn't).
    const planFixture = {
      goal: "research",
      sites: ["https://kilo.ai"],
      allowNetwork: false,
      approvedAt: 200,
      extensions: [],
    };
    await chatDb.updateConversation("parent-1", {
      mode: "plan",
      plan: planFixture,
    });

    const child = await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "research subtask",
    });

    const stored = await chatDb.getConversation(child.id);
    expect(stored?.mode).toBe("plan");
    expect(stored?.plan).toEqual(planFixture);
  });

  it("does not stamp mode/plan when parent has neither (defaults remain undefined)", async () => {
    // Parent in default Ask state — no mode, no plan. The child must
    // not synthesize fields that weren't there: undefined inherits
    // undefined, which chatDb treats as Ask + no plan.
    const child = await createChildConversation({
      parentConversationId: "parent-1",
      slug: "explore",
      isolation: "peer",
      title: "task",
    });

    const stored = await chatDb.getConversation(child.id);
    expect(stored?.mode).toBeUndefined();
    expect(stored?.plan).toBeUndefined();
  });
});
