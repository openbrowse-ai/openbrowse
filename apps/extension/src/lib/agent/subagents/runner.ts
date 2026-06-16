/**
 * Subagent runner — the central orchestrator invoked by the `delegate` tool.
 *
 * Phase 3 implements all three isolation profiles: `inline`, `peer`, and
 * `incognito`.
 *
 * Design contract (fresh-context + structured handoff):
 *  - The subagent receives NO part of the parent's chat history.
 *  - Its context is built from `agentDef.systemPrompt` + a single user
 *    message assembled from `DelegationContext`.
 *  - It returns a single `finalText` string the parent's LLM consumes.
 *
 * The actual model call is injected via `runAgentLoop` so the runner is
 * unit-testable without a live LLM. The default implementation (wired in
 * `agent-transport.ts`) spawns a nested `ToolLoopAgent`. The Chrome
 * windows API is similarly injected for `incognito`.
 */

import { chatDb } from "../../chat-db";
import type { ToolContext } from "../driver";
import type { TabId } from "../driver/browser-driver";
import { tabRegistry } from "../tab-registry";
import {
  closeIncognitoWindow,
  openIncognitoWindow,
  type WindowsAPI,
} from "./incognito-window";
import {
  createChildConversation,
  finalizeChildConversation,
} from "./child-conversation";
import {
  acquireSubagentSlot,
  releaseSubagentSlot,
} from "./concurrency";
import type {
  AgentDefinition,
  DelegationContext,
  IsolationProfile,
  SerializedAssistantMessage,
  SubagentRunResult,
} from "./types";

/**
 * Resolved configuration handed to `runAgentLoop`. The runner takes care
 * of building this from the agent definition + delegation context; the
 * loop implementation only needs to spawn the loop and surface the final
 * summary.
 */
export interface AgentLoopConfig {
  /** Final system prompt for the subagent. */
  systemPrompt: string;
  /** Single user message containing the structured handoff. */
  userMessage: string;
  /** ToolContext for the subagent's tool calls (with `session.parent` set). */
  toolContext: ToolContext;
  /** Resolved agent definition (for model/tools/maxSteps lookups). */
  agentDef: AgentDefinition;
  /** Cancellation propagated from the parent. */
  abortSignal?: AbortSignal;
  /**
   * Isolation profile in effect for this run. The loop uses it to decide
   * whether to persist transcripts (peer / incognito).
   */
  isolation: IsolationProfile;
  /**
   * Child conversation id to persist transcripts under. Non-null only for
   * peer / incognito. The loop is expected to call
   * `persistDelegationMessage` + `persistAssistantStream` against this id
   * when set.
   */
  childConversationId: string | null;
}

export interface AgentLoopResult {
  /** The final text returned to the parent's `delegate` tool. */
  finalText: string;
  /** Terminal status (`completed`, `failed`, `cancelled`, `budget-exceeded`). */
  status: SubagentRunResult["status"];
  /** Populated when status is `failed` or `budget-exceeded`. */
  errorMessage?: string;
  filesProduced?: string[];
  tabHandlesProduced?: string[];
  /**
   * Per-assistant-message transcript captured during the run. Populated
   * for all profiles (peer, incognito) so the parent's tool
   * block can render the trace without going to chat-db.
   */
  transcript?: SerializedAssistantMessage[];
}

export interface RunSubagentOptions {
  agentDef: AgentDefinition;
  context: DelegationContext;
  isolation: IsolationProfile;
  parentConversationId: string;
  parentToolContext: ToolContext;
  abortSignal?: AbortSignal;
  /**
   * Injected runner. Must be supplied by the call site that has access to
   * the model + tool set (`agent-transport.ts`). Tests pass a fake.
   */
  runAgentLoop: (config: AgentLoopConfig) => Promise<AgentLoopResult>;
  /**
   * Injected `chrome.windows` adapter, only required for `incognito`
   * isolation. Tests pass a fake; production wires
   * `getChromeWindowsAPI()` from `incognito-window.ts`.
   */
  windowsAPI?: WindowsAPI;
  /**
   * Fired once when a child conversation row is created (peer / incognito
   * isolations only). Used by the delegate tool to broadcast a
   * cross-component event so the parent's `DelegateResult` block can
   * start subscribing to the child's chat-db updates BEFORE the tool
   * actually finishes — gives users live progress visibility while the
   * subagent is still running.
   */
  onChildAssigned?: (childConversationId: string) => void;
  /**
   * The parent's `delegate` tool call id, threaded into the child
   * session as `session.parent.toolCallId`. Subagent-only tools
   * (e.g. `setTaskTitle`) broadcast UI events keyed to this id so the
   * matching `DelegateResult` block in the parent's chat picks them up.
   *
   * Optional in tests / non-extension harnesses where no AI SDK tool
   * loop drives the call.
   */
  parentToolCallId?: string;
}

export async function runSubagent(
  opts: RunSubagentOptions,
): Promise<SubagentRunResult> {
  const {
    agentDef,
    context,
    isolation,
    parentConversationId,
    parentToolContext,
    abortSignal,
    runAgentLoop,
    windowsAPI,
    onChildAssigned,
    parentToolCallId,
  } = opts;

  // Depth cap: subagents may not spawn other subagents.
  const parentDepth = parentToolContext.session?.parent?.depth ?? 0;
  if (parentDepth >= 1) {
    throw new Error(
      `Subagent depth cap exceeded — subagents may not spawn other subagents. ` +
        `Combine the work into a single delegation, or have the parent agent ` +
        `chain delegations sequentially.`,
    );
  }

  // Incognito requires the windows API.
  if (isolation === "incognito" && !windowsAPI) {
    throw new Error(
      `incognito isolation requires windowsAPI to be supplied. ` +
        `This profile only runs inside the extension; bench / unit harnesses ` +
        `should use 'peer'.`,
    );
  }

  acquireSubagentSlot(parentConversationId);

  let childConversationId: string | null = null;
  let incognitoWindowId: number | null = null;
  let ephemeralWindowId: number | undefined;

  // Single try/finally that covers both resource-acquisition steps
  // (open incognito window, create child conversation row) AND the
  // run loop. Earlier versions opened the window OUTSIDE the try, so
  // a `createChildConversation` throw left the window open and the
  // slot acquired forever. The finally block now tolerates a partial
  // setup state by null-checking each cleanup target.
  try {
    // Open the window first (incognito only) so we can stamp its id
    // onto the conversation row at creation time. If window creation
    // fails outright we still record the failure on a child row so the
    // user has something to see in the UI.
    if (isolation === "incognito") {
      try {
        const win = await openIncognitoWindow(windowsAPI!);
        incognitoWindowId = win.windowId;
        ephemeralWindowId = win.windowId;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`incognito window open failed: ${message}`);
      }
    }

    const child = await createChildConversation({
      parentConversationId,
      slug: agentDef.slug,
      isolation,
      title: deriveChildTitle(context.task),
      ...(isolation === "incognito" && { spaceId: null }),
      ...(ephemeralWindowId !== undefined && { ephemeralWindowId }),
      ...(parentToolCallId !== undefined && { parentToolCallId }),
    });
    childConversationId = child.id;

    // Notify any listeners (e.g. the delegate tool's UI broadcast) that
    // the child conversation has been created. Lets the parent's
    // `DelegateResult` block subscribe to live updates while the
    // subagent is still running.
    onChildAssigned?.(child.id);

    const childToolContext = buildChildToolContext({
      parentToolContext,
      parentConversationId,
      childConversationId,
      incognitoWindowId,
      parentToolCallId,
      isolation,
      context,
    });

    const userMessage = buildDelegationMessage(context);

    let loopResult: AgentLoopResult;
    try {
      loopResult = await runAgentLoop({
        systemPrompt: agentDef.systemPrompt,
        userMessage,
        toolContext: childToolContext,
        agentDef,
        abortSignal,
        isolation,
        childConversationId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finalizeChildConversation({
        childConversationId,
        status: "failed",
        finalText: `(failed: ${message})`,
      });
      return {
        finalText: `Subagent '${agentDef.slug}' failed: ${message}`,
        childConversationId,
        status: "failed",
        errorMessage: message,
      };
    }

    await finalizeChildConversation({
      childConversationId,
      status: loopResult.status,
      finalText: loopResult.finalText,
    });

    return {
      finalText: loopResult.finalText,
      childConversationId,
      filesProduced: loopResult.filesProduced,
      tabHandlesProduced: loopResult.tabHandlesProduced,
      transcript: loopResult.transcript,
      status: loopResult.status,
      errorMessage: loopResult.errorMessage,
    };
  } finally {
    // Close the incognito window unconditionally if it was opened —
    // covers success, failure, cancellation, and the rare "loop
    // returned but finalize threw" path. Tolerates partial setup
    // (incognito window opened but createChildConversation threw).
    if (incognitoWindowId != null && windowsAPI) {
      await closeIncognitoWindow(windowsAPI, incognitoWindowId);
      // Clear the ephemeralWindowId on the conversation row so the
      // startup orphan-cleanup pass doesn't attempt to re-close it.
      // Skip when the row was never created.
      if (childConversationId != null) {
        try {
          await chatDb.updateConversation(childConversationId, {
            ephemeralWindowId: null,
          });
        } catch {
          // chatDb may be unavailable in some test paths; ignore.
        }
      }
    }
    releaseSubagentSlot(parentConversationId);
  }
}

function buildChildToolContext(args: {
  parentToolContext: ToolContext;
  parentConversationId: string;
  childConversationId: string;
  /** windowId of the fresh incognito window for `incognito`; null for others. */
  incognitoWindowId: number | null;
  /** Parent's `delegate` tool call id, stamped onto child's `session.parent.toolCallId`. */
  parentToolCallId?: string;
  isolation: IsolationProfile;
  context: DelegationContext;
}): ToolContext {
  const {
    parentToolContext,
    parentConversationId,
    childConversationId,
    incognitoWindowId,
    parentToolCallId,
    isolation,
    context,
  } = args;

  // Fresh per-child handle map. Maps child-side handles to real tab ids
  // and back. Lives only for this subagent's run; GC'd when the closure
  // returns.
  const handleByTabId = new Map<TabId, string>();
  const tabIdByHandle = new Map<string, TabId>();
  let handleCounter = 0;

  // `attached`: seed the child handle map from the parent's named tab(s)
  // so the CUA loop's executor targets the parent's LIVE tab. We reuse the
  // SAME handle string the parent used (e.g. "t3") so the delegation
  // message and the resolver agree. cuaTabHandle records the first seeded
  // handle for the CUA loop to resolve.
  let cuaTabHandle: string | undefined;
  if (isolation === "attached") {
    const resolve = parentToolContext.session?.resolveHandle;
    const named = [
      ...(context.parentTabHandle ? [context.parentTabHandle] : []),
      ...(context.tabHandles ?? []),
    ];
    for (const handle of named) {
      const tabId = resolve?.(handle);
      if (tabId == null) continue;
      handleByTabId.set(tabId, handle);
      tabIdByHandle.set(handle, tabId);
      if (!cuaTabHandle) cuaTabHandle = handle;
      const n = Number(handle.replace(/^t/, ""));
      if (Number.isFinite(n) && n > handleCounter) handleCounter = n;
    }
  }

  const getOrCreateChildHandle = (tabId: TabId): string => {
    const existing = handleByTabId.get(tabId);
    if (existing) return existing;
    handleCounter += 1;
    const handle = `t${handleCounter}`;
    handleByTabId.set(tabId, handle);
    tabIdByHandle.set(handle, tabId);
    return handle;
  };

  const childConvId = childConversationId;

  return {
    ...parentToolContext,
    session: {
      ...parentToolContext.session,
      conversationId: childConvId,
      parent: {
        conversationId: parentConversationId,
        depth: 1,
        ...(parentToolCallId && { toolCallId: parentToolCallId }),
      },
      // For incognito: stamp the new incognito windowId so tools that create tabs
      // (navigate, etc.) target the subagent's window instead of the user's
      // active window. Peer leaves it undefined.
      ...(incognitoWindowId !== null && {
        targetWindowId: incognitoWindowId,
      }),
      ...(cuaTabHandle && { cuaTabHandle }),
      getOrCreateHandle: getOrCreateChildHandle,
      resolveHandle: (h: string) => tabIdByHandle.get(h),

      // Override conversation-bound helpers so the subagent's tool
      // calls bind tabs / read todos / check ownership on the CHILD
      // conversation, not the parent. Falls back to no-ops in non-
      // extension harnesses (where the parent's helpers are absent).
      bindTabsToConversation: makeBoundChildTabsBinder(
        parentToolContext,
        childConvId,
      ),
      bindActiveTabToConversation: makeBoundChildActiveTabBinder(
        parentToolContext,
        childConvId,
      ),
      isAgentOwnedTab: async (tabId: TabId) => {
        const conv = await chatDb.getConversation(childConvId);
        // Translate ctid → ltid via the registry; the conversation row
        // stores ownedLtids (strings), not chrome.tabs.id (numbers).
        const ltid =
          typeof tabId === "string"
            ? tabId
            : tabRegistry.toLogicalTabId(Number(tabId));
        if (ltid == null) return false;
        return !!conv?.ownedLtids.includes(ltid);
      },
      hasOwnedTabGroup: async () => {
        const conv = await chatDb.getConversation(childConvId);
        return conv?.ownedGroupId != null;
      },
      getTodos: async () => {
        const conv = await chatDb.getConversation(childConvId);
        return conv?.todos ?? [];
      },
      setTodos: async (todos) => {
        await chatDb.updateConversation(childConvId, {
          todos,
          updatedAt: Date.now(),
        });
      },
    },
  };
}

function deriveChildTitle(task: string): string {
  const trimmed = task.trim();
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + "...";
}

/**
 * Build an override for `bindTabsToConversation` that targets the CHILD
 * conversation id instead of the parent. Sends the same `chrome.runtime`
 * message the parent's session uses, so the background's `tab-scoping`
 * module rolls the tabs up under the child.
 *
 * In test / non-extension contexts there is no `chrome.runtime`; the
 * binder becomes a safe no-op (returns undefined to inherit the parent's
 * absent binder).
 */
function makeBoundChildTabsBinder(
  parentToolContext: ToolContext,
  childConversationId: string,
): ((tabIds: TabId[]) => Promise<void>) | undefined {
  if (!parentToolContext.session?.bindTabsToConversation) {
    return undefined;
  }
  return async (tabIds: TabId[]) => {
    try {
      const chromeRuntime = (globalThis as unknown as {
        chrome?: { runtime?: { sendMessage?: (msg: unknown) => Promise<unknown> } };
      }).chrome?.runtime;
      await chromeRuntime?.sendMessage?.({
        type: "BIND_TABS_TO_CONVERSATION",
        conversationId: childConversationId,
        tabIds: tabIds.map((t) => Number(t)),
      });
    } catch {
      // Background asleep; rebuilds on next startup.
    }
  };
}

function makeBoundChildActiveTabBinder(
  parentToolContext: ToolContext,
  childConversationId: string,
): ((tabId: TabId) => Promise<void>) | undefined {
  if (!parentToolContext.session?.bindActiveTabToConversation) {
    return undefined;
  }
  return async (tabId: TabId) => {
    try {
      const chromeRuntime = (globalThis as unknown as {
        chrome?: { runtime?: { sendMessage?: (msg: unknown) => Promise<unknown> } };
      }).chrome?.runtime;
      await chromeRuntime?.sendMessage?.({
        type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
        conversationId: childConversationId,
        tabId: Number(tabId),
      });
    } catch {
      // Background asleep; rebuilds on next startup.
    }
  };
}

/**
 * Assemble the single user message that becomes the subagent's first turn.
 * No parent chat history is included — fresh-context contract.
 */
function buildDelegationMessage(ctx: DelegationContext): string {
  const lines: string[] = [`Task: ${ctx.task}`];

  if (ctx.parentTabHandle) {
    lines.push("", `Active tab: ${ctx.parentTabHandle}`);
  }

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

  if (ctx.notes) {
    lines.push("", `Notes: ${ctx.notes}`);
  }

  return lines.join("\n");
}
