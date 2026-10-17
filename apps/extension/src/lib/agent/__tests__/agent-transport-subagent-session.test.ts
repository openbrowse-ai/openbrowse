/**
 * Wiring test: a peer/incognito subagent run is its own conversation, so its
 * requests must carry the CHILD conversation id as the session id, while an
 * inline run (no child conversation) shares the parent's model and id.
 *
 * `createDelegateTool` is replaced so the test can grab the `runAgentLoop`
 * the transport hands it, then drive that runner directly. The subagent is
 * stopped right after its model is created by making the second
 * `createLanguageModel` call throw, which the runner reports as a failed run.
 */

import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../types";
import type { ToolContext } from "../driver";
import type { AgentLoopConfig, AgentLoopResult } from "../subagents/runner";
import type { AgentDefinition } from "../subagents/types";

const MODEL = "opencode-go:deepseek-v4-flash";

const settings = {
  providerConfigs: { "opencode-go": { apiKey: "test-key-not-real" } },
} as unknown as Settings;

type RunAgentLoop = (cfg: AgentLoopConfig) => Promise<AgentLoopResult>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../tools/delegate");
});

async function buildTransport() {
  let runAgentLoop: RunAgentLoop | undefined;
  vi.resetModules();
  vi.doMock("../tools/delegate", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../tools/delegate")>();
    return {
      ...actual,
      createDelegateTool: (
        opts: Parameters<typeof actual.createDelegateTool>[0],
      ) => {
        runAgentLoop = opts.runAgentLoop;
        return actual.createDelegateTool(opts);
      },
    };
  });

  const { providers } = await import("@/registry/providers");
  const go = providers.find((p) => p.id === "opencode-go");
  if (!go) throw new Error("opencode-go missing from the registry");
  const spy = vi
    .spyOn(go, "createLanguageModel")
    .mockResolvedValueOnce({} as never) // the parent's model
    .mockRejectedValue(new Error("stop-after-child-model"));

  const { createAgentTransport } = await import("../agent-transport");
  await createAgentTransport(settings, MODEL, null, null, "parent-conv");
  if (!runAgentLoop) throw new Error("transport never created the delegate tool");
  return { spy, runAgentLoop };
}

const agentDef: AgentDefinition = {
  slug: "fake",
  description: "test agent",
  whenToUse: "in tests",
  systemPrompt: "test prompt",
  defaultIsolation: "peer",
  allowedTools: ["readPage"],
  maxSteps: 2,
  source: "built-in",
};

const baseCfg: Omit<AgentLoopConfig, "childConversationId"> = {
  agentDef,
  systemPrompt: "test prompt",
  userMessage: "do a thing",
  isolation: "peer" as AgentLoopConfig["isolation"],
  toolContext: {
    driver: {} as ToolContext["driver"],
    session: { conversationId: "parent-conv", spaceId: null },
  },
};

describe("createAgentTransport subagent session wiring", () => {
  it("gives a peer subagent its own child conversation id as session id", { timeout: 60_000 }, async () => {
    const { spy, runAgentLoop } = await buildTransport();

    const result = await runAgentLoop({
      ...baseCfg,
      childConversationId: "child-conv",
    });

    expect(result.status).toBe("failed");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][2]).toEqual({ sessionId: "parent-conv" });
    expect(spy.mock.calls[1][2]).toEqual({ sessionId: "child-conv" });
  });
});
