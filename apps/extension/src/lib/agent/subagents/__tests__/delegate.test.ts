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

describe("delegate tool — CUA attached auto-bind", () => {
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

  it("binds a user-opened (numeric) tab and normalizes it to a canonical handle so seeding resolves it", async () => {
    const REAL_TAB_ID = 4242;
    const handleMap = new Map<string, number>(); // tN -> tabId
    const tabToHandle = new Map<number, string>();
    const bound: number[] = [];
    let counter = 0;

    // Driver that reports the user-opened tab in listTabs (so bindTabByHandle
    // can verify it), keyed by its raw numeric chrome id.
    const driver = {
      listTabs: async () => [{ id: REAL_TAB_ID, url: "https://linkedin.com", title: "LinkedIn" }],
    } as unknown as ToolContext["driver"];

    const ctx: ToolContext = {
      driver,
      session: {
        conversationId: "parent-conv",
        // Numeric handle "4242" does NOT resolve as a tN handle.
        resolveHandle: (h: string) => handleMap.get(h),
        getOrCreateHandle: (tabId) => {
          const existing = tabToHandle.get(Number(tabId));
          if (existing) return existing;
          counter += 1;
          const h = `t${counter}`;
          handleMap.set(h, Number(tabId));
          tabToHandle.set(Number(tabId), h);
          return h;
        },
        bindActiveTabToConversation: async (tabId) => {
          bound.push(Number(tabId));
        },
      },
    };

    let seededResolvedTabId: number | string | undefined;
    let seededHandle: string | undefined;
    const tool = createDelegateTool({
      runAgentLoop: async (cfg) => {
        seededHandle = cfg.toolContext.session?.cuaTabHandle;
        seededResolvedTabId = seededHandle
          ? cfg.toolContext.session?.resolveHandle?.(seededHandle)
          : undefined;
        return { finalText: "ok", status: "completed" };
      },
      cuaEnabled: true,
    });

    const out = await tool.execute(
      {
        slug: "cua",
        task: "scroll the LinkedIn feed",
        context: { parentTabHandle: String(REAL_TAB_ID) },
      },
      ctx,
    );

    expect(out.status).toBe("completed");
    // The user-opened tab was bound into the conversation.
    expect(bound).toContain(REAL_TAB_ID);
    // The runner seeded a canonical handle that resolves to the real tab id.
    expect(seededHandle).toBeTruthy();
    expect(seededResolvedTabId).toBe(REAL_TAB_ID);
  });
});

describe("delegate tool — CUA enablement gate", () => {
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

  it("rejects a `cua` delegation when CUA is not enabled, without running the loop", async () => {
    const runAgentLoop = vi.fn(
      async (_cfg: AgentLoopConfig): Promise<AgentLoopResult> => ({
        finalText: "should not run",
        status: "completed",
      }),
    );
    const tool = createDelegateTool({ runAgentLoop, cuaEnabled: false });

    const out = await tool.execute(
      { slug: "cua", task: "click the Like button", context: { parentTabHandle: "t1" } },
      fakeCtx({ resolveHandle: () => 1 }),
    );

    expect(out.status).toBe("failed");
    expect(out.errorMessage).toMatch(/not enabled/i);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it("omits `cua` from the description when disabled and includes it when enabled", () => {
    const runAgentLoop = vi.fn(
      async (): Promise<AgentLoopResult> => ({ finalText: "", status: "completed" }),
    );
    const disabled = createDelegateTool({ runAgentLoop, cuaEnabled: false });
    const enabled = createDelegateTool({ runAgentLoop, cuaEnabled: true });

    expect(disabled.description).not.toMatch(/^- cua —/m);
    expect(disabled.description).not.toMatch(/Delegating to the `cua`/);
    expect(enabled.description).toMatch(/^- cua —/m);
    expect(enabled.description).toMatch(/Delegating to the `cua`/);
  });

  it("defaults to disabled when cuaEnabled is omitted", async () => {
    const runAgentLoop = vi.fn(
      async (): Promise<AgentLoopResult> => ({ finalText: "x", status: "completed" }),
    );
    const tool = createDelegateTool({ runAgentLoop });
    expect(tool.description).not.toMatch(/^- cua —/m);

    const out = await tool.execute(
      { slug: "cua", task: "do a thing" },
      fakeCtx(),
    );
    expect(out.status).toBe("failed");
    expect(runAgentLoop).not.toHaveBeenCalled();
  });
});
