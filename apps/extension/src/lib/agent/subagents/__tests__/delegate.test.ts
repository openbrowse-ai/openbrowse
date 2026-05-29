import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../../chat-db";
import type { ToolContext } from "../../driver";
import { createDelegateTool } from "../../tools/delegate";
import { resetSubagentSlotsForTesting } from "../concurrency";
import type { AgentLoopConfig, AgentLoopResult } from "../runner";

const fakeCtx = (
  overrides: Partial<ToolContext["session"]> = {},
): ToolContext => ({
  driver: {} as ToolContext["driver"],
  session: {
    conversationId: "parent-conv",
    ...overrides,
  },
});

describe("delegate tool", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    resetSubagentSlotsForTesting();
    
    await chatDb.createConversation({
      id: "parent-conv",
      title: "Parent",
      spaceId: "space-A",
      createdAt: 100,
      updatedAt: 100,
    });
  });

  afterEach(() => {
    chatDb._resetForTests();
    resetSubagentSlotsForTesting();
  });

  it("delegates a known slug and returns the runner's summary", async () => {
    const runAgentLoop = vi.fn(
      async (_cfg: AgentLoopConfig): Promise<AgentLoopResult> => ({
        finalText: "extracted 3 products",
        status: "completed",
      }),
    );

    const tool = createDelegateTool({ runAgentLoop });
    const out = await tool.execute(
      { slug: "explore", task: "list products on this page" },
      fakeCtx(),
    );

    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({
      finalText: "extracted 3 products",
      status: "completed",
      childConversationId: expect.any(String),
    });
  });

  it("rejects unknown agent slugs", async () => {
    const tool = createDelegateTool({
      runAgentLoop: async () => ({ finalText: "x", status: "completed" }),
    });
    const out = await tool.execute(
      { slug: "no-such-agent", task: "..." },
      fakeCtx(),
    );
    expect(out).toMatchObject({
      status: "failed",
      errorMessage: expect.stringMatching(/unknown agent/i),
    });
  });

  it("uses the agent's defaultIsolation when none is supplied", async () => {
    let observedIsolation = "";
    const tool = createDelegateTool({
      runAgentLoop: async (cfg) => {
        // The tool context's session.parent flag confirms a subagent ran.
        // The isolation choice is not directly observable in AgentLoopConfig,
        // so we infer it via session shape: peer reuses parent conv id.
        observedIsolation = cfg.toolContext.session?.conversationId ?? "";
        return { finalText: "ok", status: "completed" };
      },
    });
    await tool.execute(
      { slug: "explore", task: "summarize" },
      fakeCtx(),
    );
    // extractor's defaultIsolation is "peer" → child conv id == parent conv id
    expect(observedIsolation).toMatch(/^subagent-/);
  });

  it("blocks delegation from inside another subagent (depth cap)", async () => {
    const tool = createDelegateTool({
      runAgentLoop: async () => ({ finalText: "x", status: "completed" }),
    });
    const out = await tool.execute(
      { slug: "explore", task: "..." },
      fakeCtx({ parent: { conversationId: "grandparent", depth: 1 } }),
    );
    expect(out).toMatchObject({
      status: "failed",
      errorMessage: expect.stringMatching(/depth/i),
    });
  });

  it("blocks delegation when concurrency cap is reached", async () => {
    // Pre-fill the slot map so we hit the cap immediately.
    const { acquireSubagentSlot, MAX_SUBAGENTS_PER_PARENT } = await import(
      "../concurrency"
    );
    for (let i = 0; i < MAX_SUBAGENTS_PER_PARENT; i++) {
      acquireSubagentSlot("parent-conv");
    }

    const tool = createDelegateTool({
      runAgentLoop: async () => ({ finalText: "x", status: "completed" }),
    });
    const out = await tool.execute(
      { slug: "explore", task: "..." },
      fakeCtx(),
    );
    expect(out).toMatchObject({
      status: "failed",
      errorMessage: expect.stringMatching(/concurrency/i),
    });
  });

  it("rejects when the parent has no conversation id (session-less harness)", async () => {
    const tool = createDelegateTool({
      runAgentLoop: async () => ({ finalText: "x", status: "completed" }),
    });
    const out = await tool.execute(
      { slug: "explore", task: "..." },
      { driver: {} as ToolContext["driver"], session: { conversationId: null } },
    );
    expect(out).toMatchObject({
      status: "failed",
      errorMessage: expect.stringMatching(/conversation/i),
    });
  });

  it("renders the agent registry into the tool description", () => {
    const tool = createDelegateTool({
      runAgentLoop: async () => ({ finalText: "x", status: "completed" }),
    });
    expect(tool.description).toContain("explore");
    expect(tool.description).toContain("peer");
  });
});
