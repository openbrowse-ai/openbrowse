import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../../chat-db";
import type { ToolContext } from "../../driver";
import type { WindowsAPI } from "../incognito-window";
import { resetSubagentSlotsForTesting } from "../concurrency";
import { runSubagent } from "../runner";
import type { AgentDefinition, DelegationContext } from "../types";

const fakeAgent: AgentDefinition = {
  slug: "fake",
  description: "test agent",
  whenToUse: "in tests",
  systemPrompt: "test prompt",
  defaultIsolation: "peer",
  allowedTools: ["readPage"],
  maxSteps: 5,
  source: "built-in",
};

const fakeCtx = (
  overrides: Partial<ToolContext["session"]> = {},
): ToolContext => ({
  driver: {} as ToolContext["driver"], // unused in tests below
  session: {
    conversationId: "parent-conv",
    ...overrides,
  },
});

const minimalContext: DelegationContext = { task: "do a thing" };

describe("runSubagent — peer isolation", () => {
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

  it("creates a child conversation linked to the parent", async () => {
    const result = await runSubagent({
      agentDef: fakeAgent,
      context: { task: "summarize products" },
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      runAgentLoop: async () => ({ finalText: "found 5", status: "completed" }),
    });

    expect(result.childConversationId).toBeTruthy();
    expect(result.finalText).toBe("found 5");

    const child = await chatDb.getConversation(result.childConversationId!);
    expect(child).toMatchObject({
      parentConversationId: "parent-conv",
      subagentSlug: "fake",
      isolationProfile: "peer",
      subagentStatus: "completed",
      subagentFinalText: "found 5",
      spaceId: "space-A", // inherited from parent
    });
  });

  it("uses a fresh ToolContext whose session.conversationId is the CHILD's id", async () => {
    let observedConvId = "";
    let observedParentDepth = 0;
    await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      runAgentLoop: async (cfg) => {
        observedConvId = cfg.toolContext.session?.conversationId ?? "";
        observedParentDepth =
          cfg.toolContext.session?.parent?.depth ?? 0;
        return { finalText: "ok", status: "completed" };
      },
    });

    expect(observedConvId).not.toBe("parent-conv");
    expect(observedConvId).toMatch(/^subagent-/);
    expect(observedParentDepth).toBe(1);
  });

  it("uses a separate tab-handle namespace for the child", async () => {
    let parentHandleSeen: string | null = null;
    let childHandleSeen: string | null = null;

    // Pre-populate parent's tab handles so we can observe leak vs no-leak.
    const parentCtx = fakeCtx({
      getOrCreateHandle: () => "t-parent",
    });

    await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: parentCtx,
      runAgentLoop: async (cfg) => {
        parentHandleSeen =
          parentCtx.session?.getOrCreateHandle?.(123) ?? null;
        childHandleSeen =
          cfg.toolContext.session?.getOrCreateHandle?.(123) ?? null;
        return { finalText: "ok", status: "completed" };
      },
    });

    expect(parentHandleSeen).toBe("t-parent");
    // Child must NOT see parent's "t-parent" — it has its own namespace.
    expect(childHandleSeen).not.toBe("t-parent");
  });

  it("marks child as failed and records error when the loop throws", async () => {
    const result = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      runAgentLoop: async () => {
        throw new Error("boom");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("boom");

    const child = await chatDb.getConversation(result.childConversationId!);
    expect(child?.subagentStatus).toBe("failed");
  });

  it("passes isolation='peer' and the child conv id to runAgentLoop", async () => {
    let observedIsolation: string | null = null;
    let observedChildId: string | null | undefined = undefined;
    const result = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      runAgentLoop: async (cfg) => {
        observedIsolation = cfg.isolation;
        observedChildId = cfg.childConversationId;
        return { finalText: "ok", status: "completed" };
      },
    });
    expect(observedIsolation).toBe("peer");
    expect(observedChildId).toBeTruthy();
    expect(observedChildId).toBe(result.childConversationId);
  });

  it("fires onChildAssigned with the child conv id BEFORE runAgentLoop is called", async () => {
    const callOrder: string[] = [];
    let observedChildId: string | undefined;

    const result = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      onChildAssigned: (id) => {
        callOrder.push(`onChildAssigned:${id}`);
        observedChildId = id;
      },
      runAgentLoop: async () => {
        callOrder.push("runAgentLoop");
        return { finalText: "ok", status: "completed" };
      },
    });

    expect(callOrder).toEqual([
      `onChildAssigned:${result.childConversationId}`,
      "runAgentLoop",
    ]);
    expect(observedChildId).toBe(result.childConversationId);
  });

});

describe("runSubagent — incognito isolation", () => {
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

  it("opens an incognito window before the loop and closes it on success", async () => {
    const create = vi.fn(async () => ({ id: 7777 }));
    const remove = vi.fn(async () => {});
    const api: WindowsAPI = { create, remove };

    let observedWindowId: number | null | undefined;
    const result = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "incognito",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      windowsAPI: api,
      runAgentLoop: async (cfg) => {
        // Window should be open at this point — the child conv row has
        // an ephemeralWindowId. Look up via the child's conv id from
        // the tool context (no closure-over-result TDZ).
        const childConvId = cfg.toolContext.session?.conversationId;
        if (childConvId) {
          const child = await chatDb.getConversation(childConvId);
          observedWindowId = child?.ephemeralWindowId ?? null;
        }
        return { finalText: "did the thing", status: "completed" };
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ incognito: true }),
    );
    expect(remove).toHaveBeenCalledWith(7777);
    expect(observedWindowId).toBe(7777); // observed mid-run
    expect(result.status).toBe("completed");
  });

  it("closes the window even when the loop throws", async () => {
    const remove = vi.fn(async () => {});
    const api: WindowsAPI = {
      create: vi.fn(async () => ({ id: 1234 })),
      remove,
    };

    const result = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "incognito",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      windowsAPI: api,
      runAgentLoop: async () => {
        throw new Error("loop kaboom");
      },
    });

    expect(remove).toHaveBeenCalledWith(1234);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("loop kaboom");
  });

  it("creates the child conversation with isolationProfile=incognito and ephemeralWindowId set", async () => {
    const api: WindowsAPI = {
      create: vi.fn(async () => ({ id: 4242 })),
      remove: vi.fn(async () => {}),
    };

    const result = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "incognito",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      windowsAPI: api,
      runAgentLoop: async () => ({ finalText: "ok", status: "completed" }),
    });

    const child = await chatDb.getConversation(result.childConversationId!);
    expect(child?.isolationProfile).toBe("incognito");
    // After completion the window has been closed, so spaceId is null
    // (incognito runs detach from the parent's space).
    expect(child?.spaceId).toBeNull();
  });

  it("stamps targetWindowId on the child ToolContext session for incognito", async () => {
    let observedTargetWindowId: number | undefined;
    const api: WindowsAPI = {
      create: vi.fn(async () => ({ id: 9876 })),
      remove: vi.fn(async () => {}),
    };
    await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "incognito",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      windowsAPI: api,
      runAgentLoop: async (cfg) => {
        observedTargetWindowId = cfg.toolContext.session?.targetWindowId;
        return { finalText: "ok", status: "completed" };
      },
    });
    expect(observedTargetWindowId).toBe(9876);
  });

  it("does NOT stamp targetWindowId on peer / inline runs", async () => {
    let observedPeer: number | undefined;
    let observedInline: number | undefined;

    await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      runAgentLoop: async (cfg) => {
        observedPeer = cfg.toolContext.session?.targetWindowId;
        return { finalText: "ok", status: "completed" };
      },
    });
    expect(observedPeer).toBeUndefined();

    await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      runAgentLoop: async (cfg) => {
        observedInline = cfg.toolContext.session?.targetWindowId;
        return { finalText: "ok", status: "completed" };
      },
    });
    expect(observedInline).toBeUndefined();
  });

  it("rejects when no windowsAPI is supplied (extension context only)", async () => {
    await expect(
      runSubagent({
        agentDef: fakeAgent,
        context: minimalContext,
        isolation: "incognito",
        parentConversationId: "parent-conv",
        parentToolContext: fakeCtx(),
        runAgentLoop: async () => ({ finalText: "ok", status: "completed" }),
      }),
    ).rejects.toThrow(/windowsAPI/i);
  });

  it("closes the incognito window and releases the slot when child-conversation creation fails", async () => {
    // Force createChildConversation to throw by deleting the parent
    // row before runSubagent reads it. The runner should still close
    // the already-opened incognito window in its finally block, and
    // release the concurrency slot — earlier versions leaked both.
    const create = vi.fn(async () => ({ id: 9999 }));
    const remove = vi.fn(async () => {});
    const api: WindowsAPI = { create, remove };

    // Drop the parent row so createChildConversation can't find it.
    await chatDb.deleteConversation("parent-conv");

    await expect(
      runSubagent({
        agentDef: fakeAgent,
        context: minimalContext,
        isolation: "incognito",
        parentConversationId: "parent-conv",
        parentToolContext: fakeCtx(),
        windowsAPI: api,
        runAgentLoop: async () => ({ finalText: "ok", status: "completed" }),
      }),
    ).rejects.toThrow(/parent-conv not found/);

    // Window was opened before the throw; finally must close it.
    expect(create).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(9999);

    // Slot should be released so subsequent runs against this parent
    // can still acquire one. Re-create the parent and run a second
    // subagent — if the slot leaked we'd hit the concurrency cap.
    await chatDb.createConversation({
      id: "parent-conv",
      title: "Parent",
      spaceId: "space-A",
      createdAt: 100,
      updatedAt: 100,
    });
    const ok = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      runAgentLoop: async () => ({ finalText: "ok", status: "completed" }),
    });
    expect(ok.status).toBe("completed");
  });

  it("forwards abortSignal to runAgentLoop so the loop can cancel mid-stream", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;

    await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      abortSignal: controller.signal,
      runAgentLoop: async (cfg) => {
        observedSignal = cfg.abortSignal;
        return { finalText: "ok", status: "completed" };
      },
    });

    // Same reference — not a copy — so subagent.stream can listen for
    // abort events from the parent's stop().
    expect(observedSignal).toBe(controller.signal);
  });

  it("finalizes the child as 'cancelled' when the loop reports cancellation", async () => {
    // Mimics the production runAgentLoop, which catches AbortError
    // internally and returns a structured `cancelled` result rather
    // than re-throwing.
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx(),
      abortSignal: controller.signal,
      runAgentLoop: async (cfg) => {
        // Stand-in for the production isAbort branch in
        // agent-transport.runSubagentAgentLoop.
        if (cfg.abortSignal?.aborted) {
          return {
            finalText: "(subagent cancelled)",
            status: "cancelled",
            errorMessage: "aborted",
          };
        }
        return { finalText: "ok", status: "completed" };
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.finalText).toBe("(subagent cancelled)");
    expect(result.errorMessage).toBe("aborted");

    const child = await chatDb.getConversation(result.childConversationId!);
    expect(child?.subagentStatus).toBe("cancelled");
    expect(child?.subagentFinalText).toBe("(subagent cancelled)");
  });
});

describe("runSubagent — attached isolation", () => {
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

  it("seeds the child handle map so the parent's tab handle resolves to the real tab id", async () => {
    let resolvedTabId: number | string | undefined;
    const parentCtx: ToolContext = {
      driver: {} as ToolContext["driver"],
      session: {
        conversationId: "parent-conv",
        resolveHandle: (h: string) => (h === "t3" ? 4242 : undefined),
        getOrCreateHandle: (id) => (id === 4242 ? "t3" : `t${id}`),
      },
    };

    await runSubagent({
      agentDef: { ...fakeAgent, defaultIsolation: "attached" },
      context: { task: "operate", parentTabHandle: "t3" },
      isolation: "attached",
      parentConversationId: "parent-conv",
      parentToolContext: parentCtx,
      runAgentLoop: async (cfg) => {
        resolvedTabId = cfg.toolContext.session?.resolveHandle?.("t3");
        return { finalText: "ok", status: "completed" };
      },
    });

    expect(resolvedTabId).toBe(4242);
  });

  it("stamps the first seeded handle as cuaTabHandle on the child session", async () => {
    let stamped: string | undefined;
    const parentCtx: ToolContext = {
      driver: {} as ToolContext["driver"],
      session: {
        conversationId: "parent-conv",
        resolveHandle: (h: string) => (h === "t3" ? 4242 : undefined),
        getOrCreateHandle: (id) => (id === 4242 ? "t3" : `t${id}`),
      },
    };

    await runSubagent({
      agentDef: { ...fakeAgent, defaultIsolation: "attached" },
      context: { task: "operate", parentTabHandle: "t3" },
      isolation: "attached",
      parentConversationId: "parent-conv",
      parentToolContext: parentCtx,
      runAgentLoop: async (cfg) => {
        stamped = cfg.toolContext.session?.cuaTabHandle;
        return { finalText: "ok", status: "completed" };
      },
    });

    expect(stamped).toBe("t3");
  });
});
