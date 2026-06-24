import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import * as planStore from "@/lib/agent/plan-store";
import type { ToolContext } from "@/lib/agent/driver";
import type { ApprovedPlan, TodoItem } from "@/lib/types";

const CID = "conv-propose-plan";

/**
 * Build a minimal `ToolContext` whose `session` plumbs `getPlan`/`setPlan`
 * through to the real `plan-store` helpers (so persistence is exercised
 * end-to-end via `chatDb`), and whose `getTodos`/`setTodos` either
 * delegate to a captured array or to the override.
 */
function makeCtx(overrides?: {
  conversationId?: string | null;
  setTodosCapture?: { value: TodoItem[] | null };
}): ToolContext {
  const cid = overrides?.conversationId ?? CID;
  return {
    driver: {} as ToolContext["driver"],
    session: {
      conversationId: cid,
      spaceId: null,
      getPlan: () =>
        cid == null ? Promise.resolve(undefined) : planStore.getPlan(cid),
      setPlan: (plan: ApprovedPlan) =>
        cid == null ? Promise.resolve() : planStore.setPlan(cid, plan),
      getTodos: async () => [],
      setTodos: async (todos: TodoItem[]) => {
        if (overrides?.setTodosCapture) {
          overrides.setTodosCapture.value = todos;
        }
      },
    },
  };
}

describe("proposePlan tool", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await chatDb.createConversation({
      id: CID,
      title: "test",
      spaceId: null,
      ownedGroupId: null,
      ownedLtids: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  it("approval is required (the SDK gates the call)", async () => {
    const { proposePlanTool } = await import("@/lib/agent/tools/propose-plan");
    expect(proposePlanTool.approval?.required).toBe(true);
  });

  it("execute persists the plan to the conversation", async () => {
    const { proposePlanTool } = await import("@/lib/agent/tools/propose-plan");
    const ctx = makeCtx();
    const before = Date.now();
    const result = await proposePlanTool.execute(
      {
        goal: "Find best OSS coding model",
        sites: ["https://kilo.ai"],
        todos: [],
        allowNetwork: false,
      },
      ctx,
    );
    expect(result).toMatchObject({
      approved: true,
      plan: {
        goal: "Find best OSS coding model",
        sites: ["https://kilo.ai"],
        allowNetwork: false,
        extensions: [],
      },
    });
    expect(result.plan.approvedAt).toBeGreaterThanOrEqual(before);

    const persisted = await planStore.getPlan(CID);
    expect(persisted).toEqual(result.plan);
  });

  it("execute seeds todos into the session", async () => {
    const { proposePlanTool } = await import("@/lib/agent/tools/propose-plan");
    const capture: { value: TodoItem[] | null } = { value: null };
    const ctx = makeCtx({ setTodosCapture: capture });
    await proposePlanTool.execute(
      {
        goal: "Test goal",
        sites: [],
        todos: [{ content: "step 1" }, { content: "step 2" }],
        allowNetwork: false,
      },
      ctx,
    );
    expect(capture.value).not.toBeNull();
    expect(capture.value).toHaveLength(2);
    expect(capture.value?.[0].content).toBe("step 1");
    expect(capture.value?.[1].content).toBe("step 2");
    expect(capture.value?.[0].status).toBe("pending");
    expect(capture.value?.[0].id).toBeTruthy();
    expect(capture.value?.[0].createdAt).toBeGreaterThan(0);
    expect(capture.value?.[0].updatedAt).toBeGreaterThan(0);
  });

  it("execute throws when no session is bound (runtime contract violation)", async () => {
    const { proposePlanTool } = await import("@/lib/agent/tools/propose-plan");
    const ctx: ToolContext = { driver: {} as ToolContext["driver"] };
    await expect(
      proposePlanTool.execute(
        {
          goal: "Test",
          sites: [],
          todos: [],
          allowNetwork: false,
        },
        ctx,
      ),
    ).rejects.toThrow(/session|conversation/i);
  });

  it("execute normalizes site origins", async () => {
    const { proposePlanTool } = await import("@/lib/agent/tools/propose-plan");
    const ctx = makeCtx();
    await proposePlanTool.execute(
      {
        goal: "g",
        sites: ["https://x.com/some/path?q=1", "http://y.com:8080/x"],
        todos: [],
        allowNetwork: false,
      },
      ctx,
    );
    const plan = await planStore.getPlan(CID);
    expect(plan?.sites).toEqual(["https://x.com", "http://y.com:8080"]);
  });

  it("re-running proposePlan replaces an existing plan wholesale", async () => {
    const { proposePlanTool } = await import("@/lib/agent/tools/propose-plan");
    // Seed an initial plan with extensions.
    await planStore.setPlan(CID, {
      goal: "old",
      sites: ["https://a.com"],
      allowNetwork: false,
      approvedAt: 1000,
      extensions: [
        { kind: "site", site: "https://other.com", extendedAt: 1500 },
      ],
    });
    const ctx = makeCtx();
    const result = await proposePlanTool.execute(
      {
        goal: "new",
        sites: ["https://b.com"],
        todos: [],
        allowNetwork: true,
      },
      ctx,
    );
    expect(result.approved).toBe(true);
    expect(result.plan.goal).toBe("new");
    expect(result.plan.sites).toEqual(["https://b.com"]);
    expect(result.plan.allowNetwork).toBe(true);
    expect(result.plan.extensions).toEqual([]);

    const persisted = await planStore.getPlan(CID);
    expect(persisted?.goal).toBe("new");
    expect(persisted?.sites).toEqual(["https://b.com"]);
    expect(persisted?.allowNetwork).toBe(true);
    expect(persisted?.extensions).toEqual([]);
  });
});
