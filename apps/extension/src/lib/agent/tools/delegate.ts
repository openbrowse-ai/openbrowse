import { z } from "zod";
import { bindTabByHandle } from "../driver";
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

const isolationSchema = z.enum(["peer", "incognito", "attached"]);

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
      "REQUIRED when slug is 'cua': the handle (e.g. 't1') of the tab the " +
        "computer-use agent will control. Use a handle from the tab legend " +
        "or listTabs. If the target tab was opened by the user, it will be " +
        "bound into the conversation automatically. For other subagents this " +
        "is the active tab the parent is discussing; the subagent reads it.",
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
  /**
   * Whether the Computer Use (`cua`) subagent is enabled — i.e. a
   * computer-use-capable model is configured for it (explicit `cuaModel`
   * setting, or the main agent model is itself a configured Claude
   * computer-use model). When false, `cua` is hidden from the tool
   * description AND rejected at execute time, so the model never delegates
   * to a CUA loop that can't resolve a provider. Defaults to false.
   */
  cuaEnabled?: boolean;
}

/**
 * The `delegate` tool. Constructed via factory because the tool's
 * `description` is built dynamically from the agent registry, and its
 * `execute` closes over the injected `runAgentLoop`.
 */
export function createDelegateTool(
  opts: CreateDelegateToolOptions,
): BrowserTool<Input, Output> {
  const cuaEnabled = opts.cuaEnabled ?? false;
  return {
    name: "delegate",
    description: buildDelegateDescription(cuaEnabled),
    parameters,
    execute: async (input, ctx): Promise<Output> => {
      const parentConversationId = ctx.session?.conversationId;
      if (!parentConversationId) {
        return failure(
          input.slug,
          "delegate requires an active conversation; no conversationId in tool context.",
        );
      }

      // Gate the Computer Use subagent on configuration. When no
      // computer-use model is configured, `cua` is absent from the tool
      // description, but the model may still try it — reject clearly so it
      // can fall back to DOM tools instead of hitting an opaque provider
      // error deeper in the run.
      if (input.slug === "cua" && !cuaEnabled) {
        return failure(
          "cua",
          "Computer Use is not enabled. Select a computer-use model in Settings → General → Computer Use model, then retry. Until then, use the DOM tools (snapshot, clickElement, typeInElement, pressKey, executeOnPage) directly.",
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

      // For `attached` (CUA) subagents, the runner seeds the child handle map
      // from the parent's named tab(s). Those handles must resolve in THIS
      // (parent) context. If a referenced tab is user-opened and not yet
      // bound to the conversation, bind it now (same mechanism as `selectTab`)
      // so seeding succeeds — without this, the CUA agent fails with
      // "no parent tab handle for CUA".
      //
      // We also NORMALIZE each referenced handle to its canonical `tN` form:
      // the model may pass a raw numeric chrome tab id (from listTabs) that
      // `resolveHandle` (which keys on `tN`) can't resolve. After binding we
      // map the tab id back to its canonical handle and rewrite the context,
      // so the runner's seeding resolves it regardless of input form.
      // Best-effort: handles that can't be bound are left as-is and surfaced
      // by the CUA branch's self-healing message.
      if (isolation === "attached") {
        const normalizeHandle = async (
          handle: string,
        ): Promise<string> => {
          if (ctx.session?.resolveHandle?.(handle) != null) return handle;
          try {
            const tabId = await bindTabByHandle(ctx, handle);
            if (tabId == null) return handle;
            return ctx.session?.getOrCreateHandle?.(tabId) ?? handle;
          } catch {
            return handle;
          }
        };

        if (delegationContext.parentTabHandle) {
          delegationContext.parentTabHandle = await normalizeHandle(
            delegationContext.parentTabHandle,
          );
        }
        if (delegationContext.tabHandles?.length) {
          delegationContext.tabHandles = await Promise.all(
            delegationContext.tabHandles.map(normalizeHandle),
          );
        }
      }

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

function buildDelegateDescription(cuaEnabled: boolean): string {
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
    // Hide the Computer Use subagent unless it's enabled (a computer-use
    // model is configured). Listing it otherwise would invite delegations
    // that fail to resolve a provider.
    if (a.slug === "cua" && !cuaEnabled) continue;
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

  if (cuaEnabled) {
    lines.push(
      "",
      "Delegating to the `cua` (computer-use) subagent:",
      "- Resolve concrete targets FIRST. The subagent has fresh context and cannot resolve relative/possessive references — never pass 'my posts', 'our profile', 'the user's comments', etc. Determine the concrete profile name/URL, person, or post identifier yourself, then delegate with that explicit target.",
      "- ONE concrete action per call (e.g. \"open the comments section of the post titled X\", \"click Like on the comment by Jane Doe\"). Do NOT hand off multi-step loops, listing, or discovery.",
      "- Do the planning, listing, and looping yourself. You can perceive the page directly (snapshot → screenshot with annotate → executeOnPage); use that to enumerate items and loop, delegating each individual hard click to `cua` separately.",
      "- `cua` returns a summary of what it did and what is now on screen (often enumerating visible items). Read it, do your own perception/listing, then issue the next granular `cua` call.",
    );
  }

  return lines.join("\n");
}
