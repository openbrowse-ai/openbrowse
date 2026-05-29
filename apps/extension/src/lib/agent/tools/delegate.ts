import { z } from "zod";
import { getChromeWindowsAPI } from "../subagents/incognito-window";
import type { AgentLoopConfig, AgentLoopResult } from "../subagents/runner";
import { runSubagent } from "../subagents/runner";
import { getAgent, listAgents } from "../subagents/registry";
import type {
  DelegationContext,
  IsolationProfile,
  SubagentRunResult,
} from "../subagents/types";
import type { BrowserTool } from "../types";

/**
 * DOM event the `delegate` tool dispatches when a child conversation
 * is created mid-run (peer / incognito isolations). The parent's
 * `DelegateResult` block listens for events matching its own
 * `toolCallId` and starts subscribing to the child's chat-db updates
 * so users see live progress while the subagent is still running.
 *
 * Inline runs do not fire this event (no child conversation exists).
 */
export const SUBAGENT_CHILD_ASSIGNED_EVENT =
  "openbrowse:subagent-child-assigned";

export interface SubagentChildAssignedDetail {
  toolCallId: string;
  childConversationId: string;
}

const isolationSchema = z.enum(["peer", "incognito"]);

const delegationContextSchema = z.object({
  task: z.string().describe("Concise description of the work the subagent should do."),
  tabHandles: z
    .array(z.string())
    .optional()
    .describe("Parent's tab handles (e.g. 't3') the subagent may read."),
  urls: z
    .array(z.string())
    .optional()
    .describe("Explicit URL list when no tab handle is appropriate."),
  workspaceFiles: z
    .array(z.string())
    .optional()
    .describe("OPFS paths that contain context the subagent should read."),
  parentTabHandle: z
    .string()
    .optional()
    .describe(
      "The active tab the parent is discussing. The subagent reads this tab.",
    ),
  notes: z
    .string()
    .optional()
    .describe("Freeform extra context to pass to the subagent."),
});

const parameters = z.object({
  slug: z
    .string()
    .describe(
      "Identifier of the subagent to invoke. See the description above for the registry.",
    ),
  task: z
    .string()
    .describe(
      "Concise description of the work to delegate. The subagent's first user message is built from this.",
    ),
  isolation: isolationSchema
    .optional()
    .describe(
      "How the subagent runs relative to the parent. Defaults to the agent's recommended profile.",
    ),
  context: delegationContextSchema.partial().optional().describe(
    "Optional structured handoff: tab handles, URLs, workspace files, notes. The `task` field at the top level overrides any task field nested here.",
  ),
});

type Input = z.infer<typeof parameters>;

type Output = SubagentRunResult;

interface CreateDelegateToolOptions {
  /**
   * The function that actually runs a subagent's `ToolLoopAgent`. Injected
   * by `agent-transport.ts` (which has the model + tools) and replaced by
   * fakes in tests.
   */
  runAgentLoop: (config: AgentLoopConfig) => Promise<AgentLoopResult>;
}

/**
 * The `delegate` tool. Constructed via factory because the tool's
 * `description` is built dynamically from the agent registry, and its
 * `execute` closes over the injected `runAgentLoop`.
 */
export function createDelegateTool(
  opts: CreateDelegateToolOptions,
): BrowserTool<Input, Output> {
  return {
    name: "delegate",
    description: buildDelegateDescription(),
    parameters,
    execute: async (input, ctx): Promise<Output> => {
      const parentConversationId = ctx.session?.conversationId;
      if (!parentConversationId) {
        return failure(
          input.slug,
          "delegate requires an active conversation; no conversationId in tool context.",
        );
      }

      const agentDef = getAgent(input.slug);
      if (!agentDef) {
        const available = listAgents()
          .map((a) => a.slug)
          .join(", ");
        return failure(
          input.slug,
          `unknown agent '${input.slug}'. Available: ${available}`,
        );
      }

      const isolation: IsolationProfile =
        input.isolation ?? agentDef.defaultIsolation;

      // Merge top-level `task` with optional structured `context`.
      const delegationContext: DelegationContext = {
        task: input.task,
        tabHandles: input.context?.tabHandles,
        urls: input.context?.urls,
        workspaceFiles: input.context?.workspaceFiles,
        parentTabHandle: input.context?.parentTabHandle,
        notes: input.context?.notes,
      };

      try {
        const windowsAPI = getChromeWindowsAPI();
        const toolCallId = ctx.toolCallId;
        return await runSubagent({
          agentDef,
          context: delegationContext,
          isolation,
          parentConversationId,
          parentToolContext: ctx,
          abortSignal: ctx.signal,
          runAgentLoop: opts.runAgentLoop,
          ...(windowsAPI && { windowsAPI }),
          ...(toolCallId && { parentToolCallId: toolCallId }),
          // Broadcast the child conversation id as soon as the runner
          // creates it (before the loop starts). The parent's
          // DelegateResult block listens for this and switches its
          // transcript source to a live chat-db subscription so the
          // user sees the subagent's work appear in the inline trace
          // while the run is still in flight.
          ...(toolCallId && {
            onChildAssigned: (childConversationId: string) => {
              try {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent<SubagentChildAssignedDetail>(
                      SUBAGENT_CHILD_ASSIGNED_EVENT,
                      {
                        detail: { toolCallId, childConversationId },
                      },
                    ),
                  );
                }
              } catch {
                // Non-DOM context (service worker, tests). Live updates
                // simply won't fire there — final result still surfaces
                // the transcript via SubagentRunResult.transcript.
              }
            },
          }),
        });
      } catch (err) {
        // Validation errors thrown synchronously by runSubagent (depth cap,
        // concurrency cap, unsupported isolation) become structured failures
        // so the parent's LLM can recover gracefully.
        const message = err instanceof Error ? err.message : String(err);
        return failure(input.slug, message);
      }
    },
  };
}

function failure(slug: string, message: string): Output {
  return {
    finalText: `Subagent '${slug}' could not run: ${message}`,
    childConversationId: null,
    status: "failed",
    errorMessage: message,
  };
}

function buildDelegateDescription(): string {
  const lines: string[] = [
    "Delegate a focused task to a specialized subagent. The subagent runs with",
    "fresh context (no parent chat history), its own system prompt, and a",
    "restricted tool allowlist. It returns a short summary you continue from.",
    "",
    "Use this when:",
    "- The task would produce verbose intermediate output (long DOMs, screenshots)",
    "  that would bloat your context.",
    "- The work is self-contained and a clear summary is enough output.",
    "- A specialized subagent fits the task better than your general toolset.",
    "",
    "Caps: max 10 concurrent subagents per conversation; depth = 1 (subagents",
    "cannot spawn other subagents).",
    "",
    "Available subagents:",
  ];

  for (const a of listAgents()) {
    lines.push(`- ${a.slug} — ${a.description}`);
    lines.push(`  When to use: ${a.whenToUse}`);
    lines.push(`  Default isolation: ${a.defaultIsolation}`);
  }

  lines.push(
    "",
    "Isolation profiles:",
    "- peer: child conversation, own tab group in the same window. (Default)",
    "- incognito: child conversation in a fresh incognito window with no shared cookies, auth, or storage. Auto-closes when done. Use for auth-isolated runs (e.g. testing signup flows).",
  );

  return lines.join("\n");
}
