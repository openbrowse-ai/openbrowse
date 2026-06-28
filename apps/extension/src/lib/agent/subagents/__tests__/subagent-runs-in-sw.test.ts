import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "../../../chat-db";
import type { ToolContext } from "../../driver";
import { resetSubagentSlotsForTesting } from "../concurrency";
import type {
  AgentDefinition,
  DelegationContext,
  SubagentRunResult,
} from "../types";

/**
 * Subagents run inside whichever realm hosts the parent agent loop.
 * Pre-SW-host the parent loop lived in the renderer; post-SW-host
 * (`.superpowers/plans/2026-06-25-sw-host-agent-runs.md`) it lives in
 * the service worker.
 *
 * This regression test asserts that the subagent runner — including
 * its slot-acquisition, conversation creation, and `runAgentLoop`
 * injection — works correctly with `window` and `document`
 * stubbed-out (the SW realm shape). If a future change introduces
 * module-scope DOM access into the runner or any of its imports, this
 * test fails immediately.
 *
 * To catch module-init-time DOM reads (not just runtime reads), we
 * `vi.resetModules()` + dynamic-import `../runner` AFTER the SW
 * globals are in place. A top-level static import would resolve the
 * module before `beforeEach` runs, missing the bug class this test is
 * supposed to catch.
 */

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

const fakeCtx: ToolContext = {
  driver: {} as ToolContext["driver"],
  session: {
    conversationId: "parent-conv",
    spaceId: null,
  },
};

const minimalContext: DelegationContext = { task: "do a thing" };

describe("runSubagent in SW context", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    chatDb._resetForTests();
    resetSubagentSlotsForTesting();
    await chatDb.createConversation({
      id: "parent-conv",
      title: "Parent",
      spaceId: null,
      parentConversationId: null,
      subagentSlug: null,
      subagentStatus: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Stub the SW shape BEFORE the test imports `../runner` (done
    // dynamically below). Any module-scope DOM access in the runner
    // or its imports will then be exercised against `undefined` and
    // surface the regression at module-init time, not runtime.
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());

    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs a peer subagent and persists its transcript without touching window/document", async () => {
    const { runSubagent } = await import("../runner");
    const result: SubagentRunResult = await runSubagent({
      agentDef: fakeAgent,
      context: minimalContext,
      isolation: "peer",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx,
      runAgentLoop: async (cfg) => {
        // Verify the loop config includes a `childConversationId` for peer.
        expect(typeof cfg.childConversationId).toBe("string");
        return {
          finalText: "subagent done",
          status: "completed",
        };
      },
    });

    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("subagent done");
    // Conversation row was created for the peer child.
    expect(result.childConversationId).toBeDefined();
    const child = await chatDb.getConversation(result.childConversationId!);
    expect(child).toBeDefined();
    expect(child?.parentConversationId).toBe("parent-conv");
  });

  it("attached isolation runs to completion in SW context", async () => {
    const { runSubagent } = await import("../runner");
    const result = await runSubagent({
      agentDef: { ...fakeAgent, defaultIsolation: "attached" },
      context: minimalContext,
      isolation: "attached",
      parentConversationId: "parent-conv",
      parentToolContext: fakeCtx,
      runAgentLoop: async () => ({
        finalText: "attached done",
        status: "completed",
      }),
    });
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("attached done");
  });
});
