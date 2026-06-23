/**
 * Headless subagent runner for the bench.
 *
 * This is the bench-side analog of the extension's
 * `apps/extension/src/lib/agent/subagents/runner.ts` + the
 * `runSubagentAgentLoop` closure in `agent-transport.ts`. We replicate that
 * orchestration here rather than importing it because the extension version
 * hard-imports `chatDb` (IndexedDB) and persists child-conversation rows —
 * neither of which exists (or survives) in a headless Node trial.
 *
 * Same shared-leaf / replicated-assembly split the bench already uses for the
 * parent agent (`build-agent.ts` ≈ stripped `agent-transport.ts`): we REUSE
 * the pure pieces directly —
 *   - `@agent/subagents/concurrency` (per-parent cap = 10),
 *   - `@agent/subagents/types` (`AgentDefinition`, `DelegationContext`, ...),
 * and REPLICATE the chatDb-coupled parts (child conversation persistence is
 * simply dropped; the subagent transcript/trace is captured in-memory).
 */

import { ToolLoopAgent, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import {
  acquireSubagentSlot,
  releaseSubagentSlot,
} from "@agent/subagents/concurrency";
import type {
  AgentDefinition,
  DelegationContext,
  SubagentStatus,
} from "@agent/subagents/types";
import type { ToolContext } from "@agent/driver";
import type { TodoItem } from "../../../../apps/extension/src/lib/types";
import type { TraceEntry } from "../runner";
import { redactImageData } from "./trace-redact";

/** Resolved config handed to the injected `runAgentLoop`. */
export interface BenchAgentLoopConfig {
  systemPrompt: string;
  userMessage: string;
  toolContext: ToolContext;
  agentDef: AgentDefinition;
  abortSignal?: AbortSignal;
}

/** What the injected `runAgentLoop` returns, including bench-only trace/tokens. */
export interface BenchAgentLoopResult {
  finalText: string;
  status: Exclude<SubagentStatus, "running">;
  errorMessage?: string;
  /** The subagent's own tool-call trace (for the parent's recursive trace). */
  trace: TraceEntry[];
  /** The subagent's token usage (summed into the trial total by the runner). */
  tokens: { in: number; out: number };
}

/** Final result returned by `runBenchSubagent` to the bench delegate tool. */
export interface BenchSubagentResult {
  finalText: string;
  status: Exclude<SubagentStatus, "running">;
  errorMessage?: string;
  trace: TraceEntry[];
  tokens: { in: number; out: number };
}

export interface RunBenchSubagentOptions {
  agentDef: AgentDefinition;
  context: DelegationContext;
  parentConversationId: string;
  parentToolContext: ToolContext;
  abortSignal?: AbortSignal;
  runAgentLoop: (cfg: BenchAgentLoopConfig) => Promise<BenchAgentLoopResult>;
}

/**
 * Headless `runSubagent`. Enforces depth=1 + concurrency caps (reusing the
 * pure extension `concurrency` module), builds a fresh child ToolContext with
 * NO chatDb dependency, and delegates the model loop to the injected
 * `runAgentLoop`. Captures trace + tokens in-memory.
 */
export async function runBenchSubagent(
  opts: RunBenchSubagentOptions,
): Promise<BenchSubagentResult> {
  const {
    agentDef,
    context,
    parentConversationId,
    parentToolContext,
    abortSignal,
    runAgentLoop,
  } = opts;

  // Depth cap: subagents may not spawn other subagents.
  const parentDepth = parentToolContext.session?.parent?.depth ?? 0;
  if (parentDepth >= 1) {
    throw new Error(
      "Subagent depth cap exceeded — subagents may not spawn other subagents.",
    );
  }

  // Concurrency cap (per parent). Reuses the pure extension module.
  acquireSubagentSlot(parentConversationId);
  try {
    const childToolContext = buildBenchChildToolContext({
      parentToolContext,
      parentConversationId,
    });
    const userMessage = buildDelegationMessage(context);

    let loopResult: BenchAgentLoopResult;
    try {
      loopResult = await runAgentLoop({
        systemPrompt: agentDef.systemPrompt,
        userMessage,
        toolContext: childToolContext,
        agentDef,
        abortSignal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        finalText: `Subagent '${agentDef.slug}' failed: ${message}`,
        status: "failed",
        errorMessage: message,
        trace: [],
        tokens: { in: 0, out: 0 },
      };
    }

    return {
      finalText: loopResult.finalText,
      status: loopResult.status,
      errorMessage: loopResult.errorMessage,
      trace: loopResult.trace,
      tokens: loopResult.tokens,
    };
  } finally {
    releaseSubagentSlot(parentConversationId);
  }
}

/**
 * Build a child ToolContext for a headless subagent run. Unlike the
 * extension's `buildChildToolContext` (which gives the child its own tab
 * group + chatDb-backed conversation), the bench has a single shared browser
 * and no tab groups — so the child INHERITS the parent's tab-handle mapping
 * and driver, and only overrides: a fresh in-memory todo list, a child
 * conversation id, and `session.parent.depth = 1` (so the depth cap fires if
 * the subagent tries to delegate again). No chatDb calls.
 */
function buildBenchChildToolContext(args: {
  parentToolContext: ToolContext;
  parentConversationId: string;
}): ToolContext {
  const { parentToolContext, parentConversationId } = args;

  // Fresh in-memory todos for the child (independent of the parent's).
  let childTodos: TodoItem[] = [];

  return {
    ...parentToolContext,
    session: {
      ...parentToolContext.session,
      conversationId: `bench-subagent-${parentConversationId}`,
      spaceId: null,
      parent: {
        conversationId: parentConversationId,
        depth: 1,
      },
      // Inherit the parent's identity tab-handle mapping + ownership check so
      // the subagent perceives/acts on the SAME tabs the parent navigated to.
      getTodos: async () => childTodos,
      setTodos: async (todos) => {
        childTodos = todos;
      },
    },
  };
}

/**
 * Assemble the single user message that becomes the subagent's first turn.
 * No parent chat history is included — fresh-context contract. Mirrors the
 * extension's `buildDelegationMessage`.
 */
function buildDelegationMessage(ctx: DelegationContext): string {
  const lines: string[] = [`Task: ${ctx.task}`];
  if (ctx.parentTabHandle) lines.push("", `Active tab: ${ctx.parentTabHandle}`);
  if (ctx.tabHandles && ctx.tabHandles.length > 0) {
    lines.push("", `Tab handles: ${ctx.tabHandles.join(", ")}`);
  }
  if (ctx.urls && ctx.urls.length > 0) {
    lines.push("", "URLs:");
    for (const url of ctx.urls) lines.push(`- ${url}`);
  }
  if (ctx.workspaceFiles && ctx.workspaceFiles.length > 0) {
    lines.push("", "Workspace files:");
    for (const path of ctx.workspaceFiles) lines.push(`- ${path}`);
  }
  if (ctx.notes) lines.push("", `Notes: ${ctx.notes}`);
  return lines.join("\n");
}

/**
 * Build the injected `runAgentLoop` — the headless analog of
 * `agent-transport.ts:runSubagentAgentLoop`. Closes over the model,
 * provider options, and the parent's ALREADY-WRAPPED SDK tools. Filters those
 * tools by the subagent's `allowedTools`/`deniedTools` (always stripping
 * `delegate`, depth cap = 1), spawns a nested `ToolLoopAgent`, and captures
 * the subagent's tool-call trace + token usage in-memory.
 */
export function buildBenchSubagentLoop(args: {
  model: LanguageModel;
  /** Parent's wrapped SDK tools (the same objects the parent agent uses). */
  parentSdkTools: ToolSet;
  providerOptions?: unknown;
}): (cfg: BenchAgentLoopConfig) => Promise<BenchAgentLoopResult> {
  const { model, parentSdkTools, providerOptions } = args;

  return async (cfg: BenchAgentLoopConfig): Promise<BenchAgentLoopResult> => {
    const allow = new Set(cfg.agentDef.allowedTools);
    const deny = new Set(cfg.agentDef.deniedTools ?? []);
    const subagentTools: ToolSet = {};
    for (const [name, sdkTool] of Object.entries(parentSdkTools)) {
      if (name === "delegate") continue; // depth cap
      if (!allow.has(name)) continue;
      if (deny.has(name)) continue;
      subagentTools[name] = sdkTool;
    }

    const maxSteps = cfg.agentDef.maxSteps ?? 30;
    let stepCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const trace: TraceEntry[] = [];

    const subagent = new ToolLoopAgent({
      model,
      tools: subagentTools,
      instructions: cfg.systemPrompt,
      experimental_context: cfg.toolContext,
      ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
      onStepFinish: (step) => {
        stepCount += 1;
        const u = step.usage;
        if (u.inputTokens != null) tokensIn += u.inputTokens;
        if (u.outputTokens != null) tokensOut += u.outputTokens;
        for (const tc of step.toolCalls ?? []) {
          const output =
            step.toolResults?.find((r) => r.toolCallId === tc.toolCallId)?.output ??
            null;
          trace.push({ name: tc.toolName, input: tc.input, output: redactImageData(output) });
        }
      },
      stopWhen: stepCountIs(maxSteps),
    });

    try {
      const result = await subagent.generate({
        prompt: cfg.userMessage,
        ...(cfg.abortSignal && { abortSignal: cfg.abortSignal }),
      });
      const finalText =
        (result.text && result.text.trim().length > 0)
          ? result.text
          : `(no final text returned; subagent ran ${stepCount} step(s))`;
      const status: BenchAgentLoopResult["status"] =
        stepCount >= maxSteps && (!result.text || result.text.length === 0)
          ? "budget-exceeded"
          : "completed";
      return { finalText, status, trace, tokens: { in: tokensIn, out: tokensOut } };
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || /aborted/i.test(err.message));
      if (isAbort) {
        return {
          finalText: "(subagent cancelled)",
          status: "cancelled",
          errorMessage: "aborted",
          trace,
          tokens: { in: tokensIn, out: tokensOut },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        finalText: `(subagent error: ${message})`,
        status: "failed",
        errorMessage: message,
        trace,
        tokens: { in: tokensIn, out: tokensOut },
      };
    }
  };
}
