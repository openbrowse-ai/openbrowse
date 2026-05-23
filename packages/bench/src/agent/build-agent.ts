/**
 * Builds a minimal `ToolLoopAgent` configured for headless bench execution.
 *
 * The bench agent is intentionally smaller than the full extension agent —
 * no MCP, no skills, no chat persistence, no UI indicators. It exposes only
 * the portable page-interacting tools, a model, and a system prompt. That
 * minimalism is the point: a bench trial measures the agent core under a
 * specific (model × prompt × tool set) configuration without the
 * extension's orchestration noise.
 *
 * Tools are imported individually from their source modules (NOT through the
 * tools/ barrel) to avoid pulling in `extract.ts` and its transitive
 * `agent-transport.ts → chatDb → indexedDB` chain that crashes in Node.
 */

import { stepCountIs, ToolLoopAgent, type LanguageModel, type ToolSet } from "ai";
import { clickElementTool } from "@agent/tools/click-element";
import { executeOnPageTool } from "@agent/tools/execute-on-page";
import { listTabsTool } from "@agent/tools/list-tabs";
import { navigateTool } from "@agent/tools/navigate";
import { readPageTool } from "@agent/tools/read-page";
import { screenshotTool } from "@agent/tools/screenshot";
import { scrollPageTool } from "@agent/tools/scroll-page";
import { snapshotTool } from "@agent/tools/snapshot";
import { todoWriteTool } from "@agent/tools/todowrite";
import { typeInElementTool } from "@agent/tools/type-in-element";
import type { BrowserTool } from "@agent/types";
import type { ToolContext } from "@agent/driver";
import { SYSTEM_PROMPT } from "@agent/system-prompt";
import { shouldCompact } from "@agent/compaction";
import { buildToolToastScript } from "../drivers/visualizing-driver";
import type { TokenLimits } from "@agent/compaction";

/**
 * Catalog of page-interacting tools available to bench trials. The matrix
 * executor selects subsets by name to test "snapshot vs. screenshot vs.
 * hybrid" tool-set permutations.
 */
export const BENCH_TOOL_CATALOG: Record<string, BrowserTool<unknown, unknown>> = {
  snapshot: snapshotTool as BrowserTool<unknown, unknown>,
  clickElement: clickElementTool as BrowserTool<unknown, unknown>,
  typeInElement: typeInElementTool as BrowserTool<unknown, unknown>,
  navigate: navigateTool as BrowserTool<unknown, unknown>,
  screenshot: screenshotTool as BrowserTool<unknown, unknown>,
  scrollPage: scrollPageTool as BrowserTool<unknown, unknown>,
  readPage: readPageTool as BrowserTool<unknown, unknown>,
  executeOnPage: executeOnPageTool as BrowserTool<unknown, unknown>,
  listTabs: listTabsTool as BrowserTool<unknown, unknown>,
  todoWrite: todoWriteTool as BrowserTool<unknown, unknown>,
};

export type BenchToolName = keyof typeof BENCH_TOOL_CATALOG & string;

export const DEFAULT_TOOL_SET: BenchToolName[] = [
  "snapshot",
  "clickElement",
  "typeInElement",
  "navigate",
  "scrollPage",
  "readPage",
  "todoWrite",
];

function stripSection(prompt: string, header: string): string {
  const startIndex = prompt.indexOf(header);
  if (startIndex === -1) return prompt;
  
  // Find the next '## ' or end of string
  const nextHeaderIndex = prompt.indexOf("\n## ", startIndex + header.length);
  
  if (nextHeaderIndex === -1) {
    return prompt.substring(0, startIndex).trimEnd();
  }
  return prompt.substring(0, startIndex) + prompt.substring(nextHeaderIndex + 1);
}

export function buildBenchSystemPrompt(): string {
  let prompt = SYSTEM_PROMPT;
  prompt = stripSection(prompt, "## Virtual Workspace");
  prompt = stripSection(prompt, "## Code Execution");
  return prompt;
}

import { CompactingChatTransport } from "@agent/compacting-transport";

export interface BuildAgentOptions {
  model: LanguageModel;
  systemPrompt?: string;
  toolNames?: BenchToolName[];
  onStepFinish?: (step: Parameters<NonNullable<ConstructorParameters<typeof ToolLoopAgent>[0]["onStepFinish"]>>[0]) => void;
}

export interface BuiltAgent {
  agent: ToolLoopAgent<never, ToolSet>;
  transport: CompactingChatTransport;
  getNeedsMidStreamCompaction: () => boolean;
  /** Names of tools registered, in registration order. */
  toolNames: BenchToolName[];
}

/**
 * Convert a `BrowserTool` to the AI SDK's `ToolSet[string]` shape, threading
 * the per-call `ToolContext` from `experimental_context` into the tool's
 * native `execute(input, ctx)` signature.
 *
 * This is a stripped-down version of `apps/extension/src/lib/agent/agent-transport.ts:toSDKTool`.
 * The extension version layers in approval flows, indicator UI, tab pinning,
 * and toolResultStore bookkeeping — all extension-only concerns. The bench
 * harness needs none of that.
 */
function toBenchSDKTool(t: BrowserTool<unknown, unknown>): ToolSet[string] {
  return {
    description: t.description,
    inputSchema: t.parameters,
    outputSchema: t.outputSchema,
    strict: true,
    execute: async (
      input: unknown,
      options: { experimental_context?: unknown },
    ) => {
      const ctx = options.experimental_context as ToolContext;

      // Best-effort inject the tool call toast overlay for video recording
      try {
        const tabId = ctx.driver.getActiveTabId();
        if (tabId != null) {
          const script = buildToolToastScript(t.name, input);
          await ctx.driver.sendCommand(tabId, "Runtime.evaluate", {
            expression: script,
            returnByValue: true,
            awaitPromise: false,
          }).catch(() => {});
        }
      } catch (err) {
        // Ignore overlay injection failures
      }

      try {
        return await t.execute(input, ctx);
      } catch (err) {
        // Surface tool errors as structured results so the agent can recover
        // mid-loop instead of bailing the whole trial.
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  } as ToolSet[string];
}

export function buildBenchAgent(
  ctx: ToolContext,
  opts: BuildAgentOptions,
): BuiltAgent {
  const toolNames = opts.toolNames ?? DEFAULT_TOOL_SET;
  const tools: ToolSet = {};
  for (const name of toolNames) {
    const t = BENCH_TOOL_CATALOG[name];
    if (!t) throw new Error(`buildBenchAgent: unknown tool "${name}"`);
    tools[name] = toBenchSDKTool(t);
  }

  let needsMidStreamCompaction = false;

  const agent = new ToolLoopAgent({
    model: opts.model,
    tools,
    instructions: opts.systemPrompt ?? buildBenchSystemPrompt(),
    experimental_context: ctx,
    onStepFinish: (stepResult) => {
      opts.onStepFinish?.(stepResult);
      const usage = stepResult.usage;
      const lastTotalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      // Wait we need TokenLimits here. Let's just hardcode some reasonable token limits for the bench (128k context)
      if (shouldCompact(lastTotalTokens, { contextWindow: 128000, maxOutputTokens: 8000 })) {
        needsMidStreamCompaction = true;
      }
    },
    stopWhen: () => needsMidStreamCompaction,
  });

  const transport = new CompactingChatTransport({
    agent,
    onSendStart: () => {
      needsMidStreamCompaction = false;
    },
  });

  return { 
    agent, 
    transport, 
    getNeedsMidStreamCompaction: () => needsMidStreamCompaction, 
    toolNames 
  };
}
