/**
 * Bench `delegate` tool — headless analog of the extension's
 * `tools/delegate.ts` + `createDelegateTool`.
 *
 * We can't reuse the extension's `createDelegateTool` because it imports
 * `runSubagent` (→ chatDb) and `getChromeWindowsAPI` (→ chrome). Instead we
 * build a raw AI-SDK tool here that calls the bench's headless
 * `runBenchSubagent`. The tool's RAW output carries the subagent's trace +
 * tokens (`_benchTrace` / `_benchTokens`) so the bench runner can attach a
 * recursive sub-trace and aggregate tokens; `toModelOutput` projects ONLY the
 * `finalText` (+ status) to the model so the parent's context isn't bloated.
 */

import { z } from "zod";
import type { ToolSet } from "ai";
import type { ToolContext } from "@agent/driver";
import type { AgentDefinition, DelegationContext } from "@agent/subagents/types";
import {
  runBenchSubagent,
  type BenchAgentLoopConfig,
  type BenchAgentLoopResult,
} from "./subagent-runner";
import type { TraceEntry } from "../runner";

const delegationContextSchema = z
  .object({
    task: z.string().optional(),
    tabHandles: z.array(z.string()).optional(),
    urls: z.array(z.string()).optional(),
    workspaceFiles: z.array(z.string()).optional(),
    parentTabHandle: z.string().optional(),
    notes: z.string().optional(),
  })
  .partial();

const parameters = z.object({
  slug: z.string().describe("Identifier of the subagent to invoke."),
  task: z
    .string()
    .describe("Concise description of the work to delegate. Becomes the subagent's first message."),
  // Accepted for prompt-compatibility with the extension's delegate tool;
  // ignored headlessly (bench has no windows / child-conversation rows).
  isolation: z.enum(["peer", "incognito"]).optional(),
  context: delegationContextSchema.optional(),
});

type DelegateInput = z.infer<typeof parameters>;

/** Raw output shape; `_bench*` fields are stripped before reaching the model. */
interface DelegateOutput {
  finalText: string;
  status: string;
  errorMessage?: string;
  _benchTrace: TraceEntry[];
  _benchTokens: { in: number; out: number };
}

export interface CreateBenchDelegateToolOptions {
  agentDefs: AgentDefinition[];
  runAgentLoop: (cfg: BenchAgentLoopConfig) => Promise<BenchAgentLoopResult>;
}

/**
 * Build the bench `delegate` tool as a raw AI-SDK ToolSet entry.
 */
export function createBenchDelegateTool(
  opts: CreateBenchDelegateToolOptions,
): ToolSet[string] {
  const bySlug = new Map(opts.agentDefs.map((a) => [a.slug, a]));

  return {
    description: buildDelegateDescription(opts.agentDefs),
    inputSchema: parameters,
    execute: async (
      input: DelegateInput,
      options: { experimental_context?: unknown },
    ): Promise<DelegateOutput> => {
      const ctx = options.experimental_context as ToolContext;
      const parentConversationId = ctx.session?.conversationId;

      const fail = (message: string): DelegateOutput => ({
        finalText: `Subagent '${input.slug}' could not run: ${message}`,
        status: "failed",
        errorMessage: message,
        _benchTrace: [],
        _benchTokens: { in: 0, out: 0 },
      });

      if (!parentConversationId) {
        return fail("delegate requires an active conversation id in tool context.");
      }
      const agentDef = bySlug.get(input.slug);
      if (!agentDef) {
        const available = [...bySlug.keys()].join(", ");
        return fail(`unknown agent '${input.slug}'. Available: ${available}`);
      }

      const delegationContext: DelegationContext = {
        task: input.task,
        tabHandles: input.context?.tabHandles,
        urls: input.context?.urls,
        workspaceFiles: input.context?.workspaceFiles,
        parentTabHandle: input.context?.parentTabHandle,
        notes: input.context?.notes,
      };

      try {
        const result = await runBenchSubagent({
          agentDef,
          context: delegationContext,
          parentConversationId,
          parentToolContext: ctx,
          abortSignal: ctx.signal,
          runAgentLoop: opts.runAgentLoop,
        });
        return {
          finalText: result.finalText,
          status: result.status,
          errorMessage: result.errorMessage,
          _benchTrace: result.trace,
          _benchTokens: result.tokens,
        };
      } catch (err) {
        // Synchronous validation throws (depth/concurrency caps) → structured
        // failure so the parent LLM can recover.
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
    // Project only the model-relevant fields; strip bench-internal trace/tokens.
    toModelOutput: ({ output }: { output: DelegateOutput }) => ({
      type: "content",
      value: [
        {
          type: "text",
          text: JSON.stringify({
            finalText: output.finalText,
            status: output.status,
            ...(output.errorMessage ? { errorMessage: output.errorMessage } : {}),
          }),
        },
      ],
    }),
  } as unknown as ToolSet[string];
}

function buildDelegateDescription(agentDefs: AgentDefinition[]): string {
  const lines: string[] = [
    "Delegate a focused task to a specialized subagent. The subagent runs with",
    "fresh context (no parent chat history), its own system prompt, and a",
    "restricted tool allowlist. It returns a short summary you continue from.",
    "",
    "Caps: max 10 concurrent subagents per conversation; depth = 1 (subagents",
    "cannot spawn other subagents).",
    "",
    "Available subagents:",
  ];
  for (const a of agentDefs) {
    lines.push(`- ${a.slug} — ${a.description}`);
    lines.push(`  When to use: ${a.whenToUse}`);
  }
  return lines.join("\n");
}
