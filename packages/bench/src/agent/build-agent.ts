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
import type { ToolContext } from "@agent/driver";
import { SYSTEM_PROMPT } from "@agent/system-prompt";
import { shouldCompact } from "@agent/compaction";
import { buildToolToastScript } from "../drivers/visualizing-driver";
import {
  DEFAULT_PAGE_STATE_FIELDS,
  DEFAULT_PAGE_STATE_IMAGE_TOOLS,
  type AnyBrowserTool,
} from "../harness";
import { buildBenchSubagentLoop } from "./subagent-runner";
import { createBenchDelegateTool } from "./bench-delegate";
import type { AgentDefinition } from "@agent/subagents/types";
import type { TokenLimits } from "@agent/compaction";

/**
 * Catalog of portable page-interacting tools the bench can run WITHOUT a
 * harness (the unconfigured CLI path). Experiment-specific tools (SoM, etc.)
 * are NOT registered here — they live in out-of-tree harness files and are
 * passed in via `Harness.tools`.
 */
export const BENCH_TOOL_CATALOG = {
  snapshot: snapshotTool,
  clickElement: clickElementTool,
  typeInElement: typeInElementTool,
  navigate: navigateTool,
  screenshot: screenshotTool,
  scrollPage: scrollPageTool,
  readPage: readPageTool,
  executeOnPage: executeOnPageTool,
  listTabs: listTabsTool,
  todoWrite: todoWriteTool,
} satisfies Record<string, AnyBrowserTool>;

/**
 * Union of the catalog's tool names, e.g. `"snapshot" | "clickElement" | …`.
 * Because the catalog uses `satisfies` (not a `Record<string, …>` annotation),
 * `keyof` yields the literal union — so `DEFAULT_TOOL_SET` is checked and
 * `BENCH_TOOL_CATALOG["typo"]` is a compile error with autocomplete.
 */
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

/**
 * Default bench system prompt for the no-harness path: the production
 * extension's `SYSTEM_PROMPT` with the workspace/code-execution sections
 * stripped (bench trials have no OPFS workspace or code sandbox). Harness
 * runs supply their own full `systemPrompt` and never call this.
 */
export function buildBenchSystemPrompt(): string {
  let prompt = SYSTEM_PROMPT;
  prompt = stripSection(prompt, "## Virtual Workspace");
  prompt = stripSection(prompt, "## Code Execution");
  return prompt;
}

import { CompactingChatTransport } from "@agent/compacting-transport";

export interface BuildAgentOptions {
  model: LanguageModel;
  /** Full system prompt. Defaults to `buildBenchSystemPrompt()` (no-harness path). */
  systemPrompt?: string;
  /**
   * Tool instances available to the agent, in order. When omitted, the
   * no-harness default (`DEFAULT_TOOL_SET` resolved via `BENCH_TOOL_CATALOG`)
   * is used.
   */
   tools?: AnyBrowserTool[];
  /**
   * Whether action tools return fresh page state in their result. Default
   * true. When false, `pageStateFields` are stripped from non-image-tool
   * results so the agent only perceives state via explicit perception calls.
   */
  returnPageStateAfterAction?: boolean;
  /** Fields stripped when `returnPageStateAfterAction` is false. */
  pageStateFields?: string[];
  /** Tool names whose output carries page state as image data. */
  pageStateImageTools?: string[];
  /** Tool names whose call terminates the agent loop after the call/result. */
  terminalToolNames?: string[];
  thinking?: { enabled: boolean; budget?: number };
  /** Token limits for the mid-stream compaction threshold. */
  limits?: { contextWindow?: number; maxOutputTokens?: number };
  /**
   * Subagent definitions. When non-empty, a `delegate` tool is added to the
   * parent's tool set and wired to a headless subagent runner.
   */
  subagents?: AgentDefinition[];
  onStepFinish?: (step: Parameters<NonNullable<ConstructorParameters<typeof ToolLoopAgent>[0]["onStepFinish"]>>[0]) => void;
}

export interface BuiltAgent {
  agent: ToolLoopAgent<never, ToolSet>;
  transport: CompactingChatTransport;
  getNeedsMidStreamCompaction: () => boolean;
  /** Names of tools registered, in registration order. */
  toolNames: string[];
}

interface ToBenchToolOptions {
  returnPageStateAfterAction: boolean;
  pageStateFields: string[];
  /** Set of tool names whose output is page state as an image. */
  imageToolSet: Set<string>;
  /** Set of tool names whose call terminates the loop. */
  terminalToolSet: Set<string>;
  onTerminal: () => void;
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
 *
 * Page-state delivery is harness-driven:
 *   - When `returnPageStateAfterAction` is false, `pageStateFields` are
 *     stripped from NON-image-tool results so a vision-only arm isn't
 *     contaminated by auto-returned a11y text. The agent must call a
 *     perception (image) tool itself to see post-action state.
 *   - Image (page-state) tools route their `imageDataUrl` as a multimodal
 *     image part via `toModelOutput`; everything else is text.
 *   - Terminal tools flip the loop-stop flag after their call.
 */
function toBenchSDKTool(
  t: AnyBrowserTool,
  opts: ToBenchToolOptions,
): ToolSet[string] {
  const isImageTool = opts.imageToolSet.has(t.name);
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
        const result = await t.execute(input, ctx);

        // Strip auto-returned page-state fields from non-image-tool results
        // when the harness opts out of "return page state after action".
        if (
          !opts.returnPageStateAfterAction
          && result
          && typeof result === "object"
          && !isImageTool
        ) {
          const resObj = result as Record<string, unknown>;
          for (const field of opts.pageStateFields) {
            if (field in resObj) delete resObj[field];
          }
        }

        // Terminal tools break the agent loop after this call/result pair.
        if (opts.terminalToolSet.has(t.name)) {
          opts.onTerminal();
        }

        return result;
      } catch (err) {
        // Surface tool errors as structured results so the agent can recover
        // mid-loop instead of bailing the whole trial.
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    // Route image (page-state) tools' `imageDataUrl` as a multimodal image
    // part. All other tools just JSON-stringify their output as a text part.
    toModelOutput: isImageTool
      ? ({ output }: { output: any }) => {
          const { imageDataUrl, ...rest } = output;
          const base64 = imageDataUrl.replace(/^data:image\/png;base64,/, "");
          return {
            type: "content",
            value: [
              {
                type: "image-data",
                data: base64,
                mediaType: "image/png",
              },
              {
                type: "text",
                text: JSON.stringify(rest),
              },
            ],
          };
        }
      : undefined,
  } as unknown as ToolSet[string];
}

export function buildBenchAgent(
  ctx: ToolContext,
  opts: BuildAgentOptions,
): BuiltAgent {
  const toolInstances =
    opts.tools ?? DEFAULT_TOOL_SET.map((name) => BENCH_TOOL_CATALOG[name]);

  const returnPageStateAfterAction = opts.returnPageStateAfterAction ?? true;
  const pageStateFields = opts.pageStateFields ?? DEFAULT_PAGE_STATE_FIELDS;
  const imageToolSet = new Set(
    opts.pageStateImageTools ?? DEFAULT_PAGE_STATE_IMAGE_TOOLS,
  );
  const terminalToolSet = new Set(opts.terminalToolNames ?? []);

  // Set when the agent calls a terminal tool (e.g. a bot-block reporter).
  // Read by `stopWhen` so the ToolLoopAgent breaks its inner loop after the
  // terminal tool's call/result pair is emitted.
  let taskReportedTerminal = false;
  const onTerminal = () => {
    taskReportedTerminal = true;
  };

  const tools: ToolSet = {};
  const toolNames: string[] = [];
  for (const t of toolInstances) {
    if (!t) throw new Error("buildBenchAgent: encountered undefined tool");
    tools[t.name] = toBenchSDKTool(t, {
      returnPageStateAfterAction,
      pageStateFields,
      imageToolSet,
      terminalToolSet,
      onTerminal,
    });
    toolNames.push(t.name);
  }

  const limits: TokenLimits = {
    contextWindow: opts.limits?.contextWindow ?? 128000,
    maxOutputTokens: opts.limits?.maxOutputTokens ?? 8000,
  };

  let needsMidStreamCompaction = false;

  // Build providerOptions for thinking/reasoning when enabled. We dispatch on
  // the model id (which the AI SDK exposes via `(model as any).modelId`) so we
  // can pick the correct provider-specific options shape.
  let providerOptions: any | undefined;
  if (opts.thinking?.enabled) {
    const budget = opts.thinking.budget ?? 4096;
    const modelId = (opts.model as any).modelId ?? (opts.model as any).id ?? "";
    if (typeof modelId === "string" && modelId.startsWith("gemini-")) {
      providerOptions = {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: budget,
          },
        },
      };
    } else if (typeof modelId === "string" && modelId.startsWith("claude")) {
      providerOptions = {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized" },
        },
      };
    } else if (typeof modelId === "string" && (modelId.startsWith("gpt") || modelId.startsWith("o"))) {
      providerOptions = {
        openai: { reasoningEffort: "medium" },
      };
    }
  }

  // Subagent wiring: when the harness declares subagents, add a `delegate`
  // tool backed by the headless subagent runner. The loop filters from the
  // parent's ALREADY-WRAPPED SDK tools (so subagents inherit the same
  // page-state policy), minus `delegate` itself (depth cap = 1).
  if (opts.subagents && opts.subagents.length > 0) {
    const runAgentLoop = buildBenchSubagentLoop({
      model: opts.model,
      parentSdkTools: tools,
      providerOptions,
    });
    tools["delegate"] = createBenchDelegateTool({
      agentDefs: opts.subagents,
      runAgentLoop,
    });
    toolNames.push("delegate");
  }

  const agent = new ToolLoopAgent({
    model: opts.model,
    tools,
    instructions: opts.systemPrompt ?? buildBenchSystemPrompt(),
    experimental_context: ctx,
    ...(providerOptions ? { providerOptions } : {}),
    onStepFinish: (stepResult) => {
      opts.onStepFinish?.(stepResult);
      const usage = stepResult.usage;
      const lastTotalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (shouldCompact(lastTotalTokens, limits)) {
        needsMidStreamCompaction = true;
      }
    },
    stopWhen: () => needsMidStreamCompaction || taskReportedTerminal,
  });

  const transport = new CompactingChatTransport({
    agent,
    // Bench trials have a single user turn (the task instruction). The
    // default user-turn-based screenshot-stripping policy in the transport
    // therefore never strips anything in bench, causing context bloat as
    // perception images accumulate. Opt into the strict "only keep the
    // latest image" policy, scoped to this harness's page-state image tools,
    // so each send carries at most one image.
    keepOnlyLatestImage: true,
    screenshotToolNames: [...imageToolSet],
    onSendStart: () => {
      needsMidStreamCompaction = false;
    },
  });

  return {
    agent,
    transport,
    getNeedsMidStreamCompaction: () => needsMidStreamCompaction,
    toolNames,
  };
}
