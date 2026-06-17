import { getSkillsRegistry } from "@/lib/skills/registry";
import type { ModelDefinition } from "@/registry/providers/types";
import type {
  ChatTransport,
  JSONValue,
  LanguageModel,
  ToolLoopAgentSettings,
  ToolSet,
} from "ai";
import { ToolLoopAgent, readUIMessageStream, stepCountIs, tool } from "ai";
import { z } from "zod";
import { chatDb } from "../chat-db";
import { waitForAssistantPersist as waitForAssistantPersistImpl } from "./curator/wait-for-persist";
import { storage } from "../storage";
import { getMcpRegistry } from "../mcp";
import { sendMcpMessage } from "../mcp/messages";
import { memoryDb } from "../memory-db";
import type { AgentUIMessage, Settings } from "../types";
import { shouldCompact } from "./compaction";
import { CompactingChatTransport } from "./compacting-transport";
import { scanToolUsage, mergeDistinct } from "./tool-usage";
import { nextUsageSnapshot, type StepUsage } from "./usage-snapshot";
import { ExtensionDriver } from "./driver/extension-driver";
import type { ToolContext } from "./driver";
import { resolveCuaProvider, isAnthropicComputerUseModel } from "./cua";
import { buildThinkingProviderOptions } from "./thinking";
import type {
  AgentLoopConfig,
  AgentLoopResult,
} from "./subagents/runner";
import {
  AssistantStreamPersister,
  persistAssistantStream,
  persistDelegationMessage,
} from "./subagents/persist-stream";
import {
  getOrCreateHandle as getOrCreateTabHandle,
  loadHandlesForConversation,
  resolveHandle as resolveTabHandle,
} from "./tab-handles";
import { tabRegistry } from "./tab-registry";
import { persistCompletionMarker } from "./persist-completion-marker";
import {
  buildTabLegendEntries,
  renderTabLegend,
  buildOpenTabsAwarenessEntries,
  renderOpenTabsAwareness,
} from "./tab-legend";
import {
  renderSiteSkillsBlock,
  urlToDomain,
} from "@/lib/skills/site-skill-catalog";
import {
  clickElementTool,
  closeTabsTool,
  createScheduledTaskTool,
  createSkillTool,
  deleteMemoryTool,
  deleteSiteSkillTool,
  executeCodeTool,
  executeOnPageTool,
  extractTool,
  installSkillTool,
  listScheduledTasksTool,
  listTabsTool,
  navigateTool,
  pressKeyTool,
  readConsoleMessagesTool,
  readNetworkRequestsTool,
  readPageTool,
  recallMemoryTool,
  saveMemoryTool,
  screenshotTool,
  scrollPageTool,
  selectTabTool,
  skillTool,
  snapshotTool,
  todoWriteTool,
  typeInElementTool,
  updateMemoryTool,
  updateScheduledTaskTool,
  patchSiteSkillTool,
} from "./tools";
import { createDelegateTool } from "./tools/delegate";
import { createFsTools } from "./tools/fs";
import { createPythonTool } from "./tools/execute-python";
import { setTaskTitleTool } from "./tools/set-task-title";
import type { BrowserTool } from "./types";

import { SYSTEM_PROMPT, CUA_DELEGATION_PROMPT } from "./system-prompt";

/**
 * When true, the background site-skill curator logs each pipeline stage to the
 * service-worker console with a `[curator]` prefix (gate passed → candidate
 * counts → enqueue → drain → per-job). This pipeline runs fire-and-forget and
 * is otherwise silent on the happy path, so leave this on while the curator is
 * being validated; flip to false to quiet it.
 */
const DEBUG_CURATOR = true;

// Load-time beacon: confirms the RUNNING service worker actually has the
// curator-instrumented build. Service workers persist old code across HMR, so
// if you DON'T see this line after reloading the extension, the SW is stale —
// fully reload it from chrome://extensions. Remove with the rest of the debug
// code once the curator is validated.
if (DEBUG_CURATOR) {
  const ctx =
    typeof window !== "undefined"
      ? `window:${(globalThis as { location?: { href?: string } }).location?.href ?? "?"}`
      : "service-worker";
  console.error(`[curator] INSTRUMENTED BUILD LOADED (context=${ctx})`);
}


const MEMORY_INSTRUCTIONS = `

## Memory

You have persistent memory across conversations. The index below shows saved memories (title + description only). Use recallMemory to read full content when needed.

### How to use memories
- The index below shows [type] title: description for each memory
- Call recallMemory with the title to read the full content
- Call saveMemory to create a new memory (all fields required: title, description, type, content)
- Call updateMemory to modify an existing memory (requires user approval)
- Call deleteMemory to remove a memory

### When to save memories
- User explicitly says "remember this" or "don't forget"
- User corrects your behavior → save as feedback type
- User confirms a non-obvious approach → save as feedback type
- You learn about their role or preferences → save as user type
- You learn where external information lives → save as reference type
 - (Per-site knowledge — navigation patterns, selectors, quirks — goes in that domain's SITE SKILL, authored automatically after the task, NOT a memory.)

### Memory types
- **user**: Role, preferences, expertise. Free-form content.
- **feedback**: Behavior corrections or confirmations. Structure: rule, then **Why:** and **How to apply:** lines.
- **reference**: Where to find things externally. Free-form content.

### Scoping: user vs. space memories
Memories are either global (user-level) or scoped to a specific space.

**Save as user memory (no spaceId)** when it applies everywhere:
- Identity, name, role, company
- Universal preferences and behavior corrections

**Save as space memory (with spaceId)** when it's relevant to that space's purpose:
- Project-specific context: repos, tools, workflows for that space's domain
- Space-specific references: dashboards, docs relevant to what this space is for
- Space-specific preferences: "in this space, group tabs by project"

Rule of thumb: if it only matters when working in this particular space, scope it to the space.

### What NOT to save
- Current page content or tab URLs (ephemeral)
- Anything you can see in the current tabs
- One-off task details that won't matter next session

### When to delete memories
- User says "forget X" or "stop doing X" (if it contradicts a saved feedback)
- A memory is clearly outdated based on conversation context
`;

import { getTargetTabId } from "./active-tab";
import {
  notifyAgentStatus,
  setAgentSpaceColor,
  getAgentSpaceColor,
} from "./agent-indicator";
import { startCapture } from "./cdp-capture";
import { releaseAll as releaseAllSessions } from "./cdp-session";

export { notifyAgentStatus, setAgentSpaceColor };

const TAB_INTERACTING_TOOLS = new Set([
  "readPage",
  "screenshot",
  "navigate",
  "clickElement",
  "typeInElement",
  "scrollPage",
  "selectTab",
  "snapshot",
  "executeOnPage",
  "extract",
  "read_network_requests",
  "read_console_messages",
]);

let agentActive = false;

let agentConversationId: string | null = null;

/**
 * Per-conversation policy for HEADLESS runs (scheduled tasks). When a policy
 * is present for the active conversation, `toSDKTool`'s approval gate honors
 * `autoApprove` instead of prompting a (non-existent) human. Set by the
 * offscreen scheduled-run host around a run; cleared in its `finally`.
 */
interface HeadlessRunPolicy {
  autoApprove: boolean;
}
const headlessRunPolicies = new Map<string, HeadlessRunPolicy>();

export function setHeadlessRunPolicy(
  conversationId: string,
  policy: HeadlessRunPolicy,
): void {
  headlessRunPolicies.set(conversationId, policy);
}

export function clearHeadlessRunPolicy(conversationId: string): void {
  headlessRunPolicies.delete(conversationId);
}

let lastTotalTokens = 0;
let currentModelDef: ModelDefinition | undefined;

/**
 * The LanguageModel instance for the currently-active agent session is
 * held in {@link ./current-agent-model.ts} so tools and the completion-check
 * evaluator can read it without dragging the full agent-transport
 * import graph into their unit tests. We re-export the accessors here
 * so existing call sites that imported them from this module keep
 * working.
 */
export {
  getCurrentAgentModel,
  setCurrentAgentModel,
} from "./current-agent-model";
import { setCurrentAgentModel } from "./current-agent-model";

export function getLastTotalTokens(): number {
  return lastTotalTokens;
}

export function setCurrentModelDef(model: ModelDefinition | undefined) {
  currentModelDef = model;
}

export function getCurrentModelDef(): ModelDefinition | undefined {
  return currentModelDef;
}

export function needsCompaction(): boolean {
  if (lastTotalTokens === 0) return false;
  return shouldCompact(lastTotalTokens, currentModelDef);
}

export function resetTokenTracking() {
  lastTotalTokens = 0;
}

/**
 * Set the conversation that subsequent agent loops should bind to. This is
 * the source of truth read by `CompactingChatTransport.sendMessages` (and
 * by the wrapper around each tool call) at the moment a loop starts; from
 * that point on the cid is captured and pinned for the duration of the
 * loop / tool call.
 *
 * In-memory tab-handle maps for previously-active conversations are
 * intentionally retained. The maps in `tab-handles.ts` are keyed by
 * conversation id, so multiple conversations' handle maps coexist without
 * interference. Wiping a previous conversation's map here used to corrupt
 * any in-flight tool call still resolving handles for that conversation
 * after a mid-stream switch; keeping them in memory is correct and the
 * memory cost (a few ints per tab) is negligible. The persisted record in
 * chatDb (`handleState`) remains the durable source of truth and is
 * re-merged on next activation by `loadHandlesForConversation`.
 */
export function setAgentContext(conversationId: string | null) {
  agentConversationId = conversationId;
  // Hydrate the persisted handle map for the new conversation. Fire-and-
  // forget: tools that hit a not-yet-hydrated map will see "Unknown tab
  // handle" and recover via listTabs. In practice the user-message →
  // first-tool-call window is large enough for this to settle.
  // `loadHandlesForConversation` merges restored state into whatever
  // in-memory state already exists for this cid, so re-firing on every
  // call is idempotent.
  if (conversationId) {
    loadHandlesForConversation(conversationId).catch(() => {});
  }
}

export function getAgentContext(): {
  conversationId: string | null;
} {
  return {
    conversationId: agentConversationId,
  };
}


const IMAGE_TOOLS = new Set(["screenshot"]);

export const toolResultStore = new Map<string, unknown>();

// Stores the tab ID captured at tool-call time for approval-required tools,
// so execution targets the correct tab regardless of user's browsing activity.
const capturedTabIds = new Map<string, number>();

// Stores the site origin for each pending approval, so the UI can show
// "Always allow on <site>" and the transport can skip approval for allowed sites.
export const capturedToolOrigins = new Map<string, string>();

export interface ToolTabInfo {
  tabId: number;
  title: string;
  favIconUrl?: string;
}

export const toolTabInfoStore = new Map<string, ToolTabInfo>();

const SITE_ALLOWLIST_KEY = "tool-site-allowlist";

export async function getToolSiteAllowlist(): Promise<
  Record<string, string[]>
> {
  const result = await chrome.storage.local.get(SITE_ALLOWLIST_KEY);
  return (result[SITE_ALLOWLIST_KEY] as Record<string, string[]>) ?? {};
}

export async function allowToolOnSite(
  toolName: string,
  origin: string,
): Promise<void> {
  const allowlist = await getToolSiteAllowlist();
  const existing = allowlist[toolName] ?? [];
  if (!existing.includes(origin)) {
    allowlist[toolName] = [...existing, origin];
    await chrome.storage.local.set({ [SITE_ALLOWLIST_KEY]: allowlist });
  }
}

const CLOSE_TABS_ALWAYS_ALLOW_KEY = "close-tabs-always-allow";

/**
 * Ownership-scoped "always allow" for closeTabs. Unlike the per-site
 * allowlist, this is a single global boolean: "always allow closing tabs
 * the agent opened." It only ever takes effect when EVERY target tab is
 * agent-owned (see `shouldAutoApproveCloseTabs`), so the blast radius is
 * bounded to tabs the agent itself created.
 */
export async function isCloseTabsAlwaysAllowed(): Promise<boolean> {
  const r = await chrome.storage.local.get(CLOSE_TABS_ALWAYS_ALLOW_KEY);
  return r[CLOSE_TABS_ALWAYS_ALLOW_KEY] === true;
}

export async function setCloseTabsAlwaysAllowed(
  allowed: boolean,
): Promise<void> {
  await chrome.storage.local.set({ [CLOSE_TABS_ALWAYS_ALLOW_KEY]: allowed });
}

/**
 * Resolve the target ltids for a closeTabs auto-approve check against the
 * conversation's owned tabs.
 */
async function resolveCloseTabsTargetIds(
  conversationId: string,
  input: { target: "group" } | { target: "tabs"; ltids: string[] },
): Promise<string[]> {
  if (input.target === "group") {
    const conv = await chatDb.getConversation(conversationId);
    return conv?.ownedLtids ?? [];
  }
  return input.ltids;
}

/**
 * True when a closeTabs call may skip approval: the global flag is on AND
 * every target tab is in the conversation's ownedLtids. Any non-owned
 * target forces manual approval regardless of the flag.
 */
export async function shouldAutoApproveCloseTabs(
  conversationId: string,
  input: { target: "group" } | { target: "tabs"; ltids: string[] },
): Promise<boolean> {
  if (!(await isCloseTabsAlwaysAllowed())) return false;
  const conv = await chatDb.getConversation(conversationId);
  if (!conv) return false;
  const owned = new Set<string>(conv.ownedLtids);
  const targets = await resolveCloseTabsTargetIds(conversationId, input);
  if (targets.length === 0) return false;
  return targets.every((id) => owned.has(id));
}

/**
 * Singleton driver instance for the production extension. Tools receive this
 * via the `ToolContext` built per-tool-call inside `toSDKTool.execute`.
 * Stateless; the driver itself is just a thin facade over
 * `cdp-session`/`active-tab`.
 */
const extensionDriver = new ExtensionDriver();

/**
 * Build the `ToolContext` for a single tool call.
 *
 * The `pinnedConversationId` argument is captured synchronously at the
 * tool-call boundary (see `toSDKTool.execute`) and threaded through every
 * session helper. This guarantees that even if `setAgentContext(...)` is
 * called mid-execute (e.g. the user switches conversations while a tool
 * await is pending), all chatDb reads/writes and tab-handle lookups for
 * this tool call still target the conversation that originated the call.
 *
 * The bench harness builds its own minimal context with `session` left
 * undefined.
 */
/**
 * Build the browser tool set. Extracted from `createAgentTransport` so the
 * headless scheduled-run loop can reuse the exact same tool wrappers. Every
 * tool — including the fs and Python tools — resolves its conversation id
 * (and the rest of its `ToolContext`) at call time from the SDK's
 * `experimental_context` (or the module-level `agentConversationId`), so
 * this function takes no conversation argument and the wrappers stay valid
 * across a null→id transition (e.g. a brand-new chat) and for subagents.
 */
export function createBrowserToolSet(): Record<string, ToolSet[string]> {
  const fsTools = createFsTools();
  const pythonTool = createPythonTool();
  // Foreground self-heal guard: the main agent authors nothing from scratch
  // (the background curator does that). It may only patch an EXISTING site
  // skill — typically to fix a scriptRef it just ran and judged deficient.
  // (The curator wraps the raw patchSiteSkillTool directly, bypassing this.)
  const guardedPatchSiteSkill: typeof patchSiteSkillTool = {
    ...patchSiteSkillTool,
    execute: async (input, ctx) => {
      try {
        await getSkillsRegistry().init();
        const exists = getSkillsRegistry()
          .getState()
          .skills.some((s) => s.kind === "site" && s.name === input.domain);
        if (!exists) {
          return {
            error: `No site skill exists for "${input.domain}" yet. The background curator authors new site skills after the task ends — you only read and self-heal existing ones. Proceed without saving.`,
          };
        }
      } catch {
        // If the registry check fails, fall through and let the patch attempt.
      }
      return patchSiteSkillTool.execute(input, ctx);
    },
  };
  return {
    snapshot: toSDKTool(snapshotTool, "snapshot"),
    readPage: toSDKTool(readPageTool, "readPage"),
    screenshot: toSDKTool(screenshotTool, "screenshot"),
    listTabs: toSDKTool(listTabsTool, "listTabs"),
    navigate: toSDKTool(navigateTool, "navigate"),
    clickElement: toSDKTool(clickElementTool, "clickElement"),
    typeInElement: toSDKTool(typeInElementTool, "typeInElement"),
    pressKey: toSDKTool(pressKeyTool, "pressKey"),
    scrollPage: toSDKTool(scrollPageTool, "scrollPage"),
    selectTab: toSDKTool(selectTabTool, "selectTab"),
    closeTabs: toSDKTool(closeTabsTool, "closeTabs"),
    saveMemory: toSDKTool(saveMemoryTool, "saveMemory"),
    updateMemory: toSDKTool(updateMemoryTool, "updateMemory"),
    recallMemory: toSDKTool(recallMemoryTool, "recallMemory"),
    deleteMemory: toSDKTool(deleteMemoryTool, "deleteMemory"),
    executeCode: toSDKTool(executeCodeTool, "executeCode"),
    executeOnPage: toSDKTool(executeOnPageTool, "executeOnPage"),
    read_network_requests: toSDKTool(readNetworkRequestsTool, "read_network_requests"),
    read_console_messages: toSDKTool(readConsoleMessagesTool, "read_console_messages"),
    patch_site_skill: toSDKTool(guardedPatchSiteSkill, "patch_site_skill"),
    delete_site_skill: toSDKTool(deleteSiteSkillTool, "delete_site_skill"),
    executePython: toSDKTool(pythonTool, "executePython"),
    extract: toSDKTool(extractTool, "extract"),
    todoWrite: toSDKTool(todoWriteTool, "todoWrite"),
    skill: toSDKTool(skillTool, "skill"),
    install_skill: toSDKTool(installSkillTool, "install_skill"),
    create_skill: toSDKTool(createSkillTool, "create_skill"),
    create_scheduled_task: toSDKTool(
      createScheduledTaskTool,
      "create_scheduled_task",
    ),
    list_scheduled_tasks: toSDKTool(
      listScheduledTasksTool,
      "list_scheduled_tasks",
    ),
    update_scheduled_task: toSDKTool(
      updateScheduledTaskTool,
      "update_scheduled_task",
    ),
    Read: toSDKTool(fsTools.readTool, "Read"),
    Write: toSDKTool(fsTools.writeTool, "Write"),
    Edit: toSDKTool(fsTools.editTool, "Edit"),
    Glob: toSDKTool(fsTools.globTool, "Glob"),
    Grep: toSDKTool(fsTools.grepTool, "Grep"),
    LS: toSDKTool(fsTools.lsTool, "LS"),
    Delete: toSDKTool(fsTools.deleteTool, "Delete"),
  };
}

export function buildExtensionToolContext(
  pinnedConversationId: string | null,
): ToolContext {
  return {
    driver: extensionDriver,
    session: {
      conversationId: pinnedConversationId,
      bindTabsToConversation: async (tabIds) => {
        if (!pinnedConversationId) return;
        try {
          await chrome.runtime.sendMessage({
            type: "BIND_TABS_TO_CONVERSATION",
            conversationId: pinnedConversationId,
            tabIds: tabIds.map((t) => Number(t)),
          });
        } catch {
          // Background asleep; rebuilds on next startup.
        }
      },
      bindActiveTabToConversation: async (tabId) => {
        if (!pinnedConversationId) return;
        try {
          await chrome.runtime.sendMessage({
            type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
            conversationId: pinnedConversationId,
            tabId: Number(tabId),
          });
        } catch {
          // Background asleep; rebuilds on next startup.
        }
      },
      getOrCreateHandle: (tabId) => {
        // The session API surface accepts a `TabId` (string|number) for
        // historical reasons; post-migration the value is a LogicalTabId
        // (string). On the extension we only ever receive strings here
        // — tools call this with `tabRegistry.registerExisting(ctid)` for
        // newly-discovered tabs, or with an existing ltid retrieved from
        // a previous lookup. Defensive numeric coercion below routes a
        // raw ctid through the registry to mint/recover an ltid; this
        // keeps the older bench-harness call sites working unchanged.
        if (!pinnedConversationId) return `t${tabId}`;
        const ltid =
          typeof tabId === "number"
            ? tabRegistry.registerExisting(tabId)
            : tabId;
        return getOrCreateTabHandle(pinnedConversationId, ltid);
      },
      resolveHandle: (handle) => {
        return pinnedConversationId
          ? resolveTabHandle(pinnedConversationId, handle)
          : undefined;
      },
      isAgentOwnedTab: async (tabId) => {
        if (!pinnedConversationId) return false;
        const conv = await chatDb.getConversation(pinnedConversationId);
        // `tabId` here is the chrome.tabs.id (number) the caller has in
        // hand. Translate to ltid via the registry to test against the
        // conversation's ownedLtids list.
        const ltid = tabRegistry.toLogicalTabId(Number(tabId));
        if (ltid == null) return false;
        return !!conv?.ownedLtids.includes(ltid);
      },
      hasOwnedTabGroup: async () => {
        if (!pinnedConversationId) return false;
        const conv = await chatDb.getConversation(pinnedConversationId);
        return conv?.ownedGroupId != null;
      },
      getTodos: async () => {
        if (!pinnedConversationId) return [];
        const conv = await chatDb.getConversation(pinnedConversationId);
        return conv?.todos || [];
      },
      setTodos: async (todos) => {
        if (!pinnedConversationId) return;
        await chatDb.updateConversation(pinnedConversationId, {
          todos,
          updatedAt: Date.now(),
        });
      },
      resolveNewTabWindowId: async () => {
        if (!pinnedConversationId) return undefined;
        const conv = await chatDb.getConversation(pinnedConversationId);
        if (!conv) return undefined;
        // 1) Prefer the window of an existing owned tab so new tabs join
        //    the conversation's tab group rather than splitting across
        //    windows. Probe in order and take the first live tab. Each
        //    `ownedLtids` entry is a LogicalTabId (string); resolve to a
        //    chrome ctid via the registry before calling chrome.tabs.get.
        for (const ltid of conv.ownedLtids ?? []) {
          const ctid = tabRegistry.toChromeTabId(ltid);
          if (ctid == null) continue;
          try {
            const tab = await chrome.tabs.get(ctid);
            if (typeof tab.windowId === "number") return tab.windowId;
          } catch {
            // Tab gone; try the next owned id.
          }
        }
        // 2) Otherwise fall back to the conversation's space window (the
        //    window the chat is bound to), as long as it still exists.
        if (conv.spaceId) {
          const spaces = await storage.getSpaces();
          const space = spaces.find((s) => s.id === conv.spaceId);
          const windowId = space?.windowId;
          if (typeof windowId === "number") {
            try {
              await chrome.windows.get(windowId);
              return windowId;
            } catch {
              // Space's window was closed; fall through.
            }
          }
        }
        // 3) No resolvable window — caller omits windowId (focused window).
        return undefined;
      },
    },
  };
}

/**
 * Wrap a `BrowserTool` in the AI SDK's tool shape so the SDK can call
 * it with `(input, options)` semantics. Handles approval gating, tab
 * resolution, abort-signal propagation, and result capture.
 *
 * Exported for unit tests that exercise the wrapper's contract directly
 * (in particular, that `options.abortSignal` is forwarded into
 * `ctx.signal` so `delegate` can cancel running subagents). Production
 * callers should use the pre-built tool sets exposed below.
 */
export function toSDKTool<TInput, TOutput>(
  t: BrowserTool<TInput, TOutput>,
  toolKey: string,
): ToolSet[string] {
  const isTabTool = TAB_INTERACTING_TOOLS.has(toolKey);
  const isImageTool = IMAGE_TOOLS.has(toolKey);

  const approvalRequired = t.approval?.required ?? false;

  /**
   * Resolve the `tab` arg from a tool's input to a real chrome tab id +
   * origin, used by both the approval allowlist check and the per-tool-call
   * origin capture for the "Always allow on <site>" UI.
   *
   * Takes an explicit `cid` rather than reading the module-level
   * `agentConversationId` so that a single tool call (which may invoke
   * this from `needsApproval`, `onInputAvailable`, and `execute` separately)
   * always resolves against the same conversation map even if the user
   * switches conversations mid-call.
   *
   * Returns `null` if no cid is provided, no handle is present, the handle
   * doesn't resolve (stale handle, conversation switch mid-flight), or
   * `chrome.tabs.get` rejects (closed tab). Callers fall back to safe
   * defaults in that case.
   */
  const resolveTabFromInput = async (
    cid: string | null,
    input: unknown,
  ): Promise<{ tabId: number; tab: chrome.tabs.Tab } | null> => {
    if (!cid) return null;
    const handle = (input as { tab?: unknown })?.tab;
    if (typeof handle !== "string" || handle.length === 0) return null;
    const ltid = resolveTabHandle(cid, handle);
    if (ltid == null) return null;
    // resolveTabHandle returns a LogicalTabId; translate to a chrome ctid
    // via the registry. Unresolvable ltids (the underlying tab is gone)
    // bail to null so the caller falls back to "require approval".
    const tabId = tabRegistry.toChromeTabId(ltid);
    if (tabId == null) return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      return { tabId, tab };
    } catch {
      return null;
    }
  };

  /**
   * Generic approval gate for a tab-interacting tool: consult the per-site
   * "Always allow on <site>" allowlist for the tool's target tab; require a
   * prompt otherwise.
   *
   * The AI SDK calls `needsApproval(input, options)` — `input` is the first
   * positional arg (the tool's parsed input), NOT `{ input }`. (A prior bug
   * destructured `{ input }`, read `input.input` (undefined), so the handle
   * never resolved and approval was ALWAYS required — the allowlist was never
   * consulted, so "Always allow on <site>" never took effect.) Capture cid
   * once at entry — see resolveTabFromInput's contract.
   */
  const tabToolNeedsApproval = async (input: unknown): Promise<boolean> => {
    const cid = agentConversationId;
    const resolved = await resolveTabFromInput(cid, input);
    if (resolved?.tab.url) {
      try {
        const origin = new URL(resolved.tab.url).origin;
        const allowlist = await getToolSiteAllowlist();
        const allowed = allowlist[toolKey] ?? [];
        if (allowed.includes(origin)) return false;
      } catch {}
    }
    return true;
  };

  const needsApproval =
    approvalRequired && toolKey === "executePython"
      ? // Python only needs human approval when it requests outbound network
        // access. Sandboxed runs (no `allow_network`, the default) touch only
        // the conversation's OPFS workspace + read-only /skills — as safe as
        // the always-available fs tools — so they execute without a prompt.
        // The SDK passes the parsed tool input as the first positional arg.
        (input: unknown) =>
          (input as { allow_network?: unknown })?.allow_network === true
      : approvalRequired && toolKey === "closeTabs"
      ? async (input: unknown) => {
          const cid = agentConversationId;
          if (!cid) return true;
          const typed = input as
            | { target: "group" }
            | { target: "tabs"; handles?: string[] };
          let resolved:
            | { target: "group" }
            | { target: "tabs"; ltids: string[] };
          if (typed?.target === "tabs") {
            // Tool handles → ltids via the per-conversation handle map.
            // resolveTabHandle returns LogicalTabId post-migration; drop
            // unresolvable handles silently (the tool itself surfaces the
            // error message; this path only decides whether approval is
            // required, and a missing handle defaults to "require approval").
            const ltids = (typed.handles ?? [])
              .map((h) => resolveTabHandle(cid, h))
              .filter((id): id is string => typeof id === "string");
            resolved = { target: "tabs", ltids };
          } else {
            resolved = { target: "group" };
          }
          return !(await shouldAutoApproveCloseTabs(cid, resolved));
        }
      : approvalRequired && toolKey === "executeOnPage"
      ? // A `scriptRef` run executes an ALREADY-SAVED script from one of the
        // agent's own site skills (authored by the background curator) — no prompt,
        // same trust basis as the no-approval site-skill patch/delete.
        // This also removes the model's incentive to `Read` the body before
        // running (to make an opaque approval legible), which would defeat
        // run-by-reference. Inline `code` is arbitrary new JS → normal gate.
        async (input: unknown) => {
          const typed = input as { scriptRef?: unknown; code?: unknown };
          if (typed?.scriptRef != null && typed.code == null) return false;
          return tabToolNeedsApproval(input);
        }
      : approvalRequired && isTabTool
        ? (input: unknown) => tabToolNeedsApproval(input)
        : approvalRequired;

  /**
   * Wrap the resolved `needsApproval` so that during a HEADLESS scheduled
   * run with `autoApprove`, approval-gated tools execute without prompting
   * (there's no human to approve). When the policy is absent or
   * `autoApprove` is false, the original behavior applies. (Approval-gated
   * tools are omitted entirely from non-auto-approve headless runs at the
   * tool-set level, so this branch only matters for auto-approve.)
   */
  const needsApprovalWithHeadless =
    approvalRequired && typeof needsApproval !== "boolean"
      ? async (input: unknown, opts: unknown) => {
          const cid = agentConversationId;
          const policy = cid ? headlessRunPolicies.get(cid) : undefined;
          if (policy?.autoApprove) return false;
          return (
            needsApproval as (i: unknown, o: unknown) => Promise<boolean>
          )(input, opts);
        }
      : approvalRequired
        ? async () => {
            const cid = agentConversationId;
            const policy = cid ? headlessRunPolicies.get(cid) : undefined;
            if (policy?.autoApprove) return false;
            return true;
          }
        : needsApproval;

  const execute = async (
    input: TInput,
    options: {
      toolCallId: string;
      experimental_context?: unknown;
      /**
       * Forwarded by the AI SDK on every tool invocation. When the
       * outer chat stream is aborted (user clicks Stop, or the parent
       * loop is cancelled), this signal fires so tools that wrap
       * long-running async work — most importantly `delegate`, which
       * runs an entire subagent loop — can propagate the cancellation
       * downstream. We stamp it onto `ctx.signal` below so tools read
       * it through the portable ToolContext surface rather than
       * coupling to the SDK's options shape.
       */
      abortSignal?: AbortSignal;
    },
  ) => {
    // Capture cid once at entry. Every chatDb / handle-map operation
    // reachable from this tool call — both inside the wrapper
    // (resolveTabFromInput, capture stores) and inside the tool's own
    // execute via `ctx.session` — pins to this snapshot. So if the user
    // switches conversations mid-tool-await, the in-flight call still
    // writes to the conversation that originated it.
    const cid = agentConversationId;
    capturedToolOrigins.delete(options.toolCallId);

    // Non-auto-approve headless runs have no human to approve a network
    // request, so force `executePython` to run sandboxed regardless of what
    // the model passed. This pairs with keeping the tool available headless
    // (it's no longer in HEADLESS_DROP): sandboxed Python is safe, networked
    // Python in an unattended run is not.
    let effectiveInput = input;
    if (toolKey === "executePython") {
      const policy = cid ? headlessRunPolicies.get(cid) : undefined;
      if (policy && !policy.autoApprove) {
        effectiveInput = {
          ...(input as Record<string, unknown>),
          allow_network: false,
        } as TInput;
      }
    }

    if (isTabTool) {
      agentActive = true;
      // Resolve the tab this tool will operate on FIRST, then show the
      // blocking indicator on that specific tab. Resolving before
      // notifying ensures the indicator targets the agent's actual
      // working tab — not whatever tab the user is currently focused on
      // (which may be a different, non-worked tab in the same window when
      // the agent works inside its owned tab group).
      const resolved = await resolveTabFromInput(cid, input);
      if (resolved) {
        toolTabInfoStore.set(options.toolCallId, {
          tabId: resolved.tabId,
          title: resolved.tab.title ?? "",
          favIconUrl: resolved.tab.favIconUrl,
        });
      }
      notifyAgentStatus(true, getAgentSpaceColor(), resolved?.tabId ?? null);
      // Eagerly arm CDP capture for the worked tab BEFORE the tool runs,
      // so any network/console events the tool itself triggers (or the
      // page issues during the tool's wait) land in the buffer.
      // `startCapture` is idempotent: a no-op when the tab is already
      // tracked (which it is for every tool call after the first against
      // a given tab in an agent run). Awaiting matters because
      // `chrome.debugger.attach + Network.enable` is async — without the
      // await, the very first tool call against a tab races the attach
      // and misses its own events. (`agent-indicator.notifyAgentStatus`
      // ALSO calls `startCapture` fire-and-forget as a backstop for
      // non-tab-tool turns; this awaited call wins on tab-tool calls.)
      if (resolved?.tabId != null) {
        await startCapture(resolved.tabId).catch(() => {});
      }
    }
    try {
      // Threaded ToolContext from the SDK's experimental_context channel.
      // Subagents inject their child ToolContext this way; for the parent
      // agent, we fall back to building one fresh, pinned to the cid we
      // captured above so a mid-call conversation switch can't race.
      const baseCtx = (options.experimental_context as ToolContext | undefined)
        ?? buildExtensionToolContext(cid);
      // Stamp the toolCallId on a per-invocation ctx copy so tools that
      // need it (e.g. `delegate` for live-progress broadcasts) can read
      // it without changing the BrowserTool signature.
      //
      // Also stamp `signal` from the SDK's per-call abortSignal. This
      // is what makes Stop work for `delegate`: ctx.signal flows into
      // runSubagent → subagent.stream({ abortSignal }), and recursively
      // into every child tool's own execute via the same wrapper.
      // baseCtx.signal (if any) is overridden — the SDK's per-call
      // signal is always the most accurate source of truth.
      //
      // We wrap it in a fresh AbortController tracked globally so
      // `resetAgentIndicator` can forcefully abort tools when the
      // parent connection drops or the turn is interrupted.
      const ac = new AbortController();
      activeToolAbortControllers.add(ac);
      const onAbort = () => ac.abort();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) onAbort();
        else options.abortSignal.addEventListener("abort", onAbort);
      }
      
      const ctx: ToolContext = {
        ...baseCtx,
        toolCallId: options.toolCallId,
        signal: ac.signal,
      };
      
      try {
        const result = await t.execute(effectiveInput, ctx);
        toolResultStore.set(options.toolCallId, result);
        if (isTabTool) {
          // Refresh the tab info post-execute so the UI shows the landed
          // URL/title (navigate / clickElement may have changed it).
          const resolved = await resolveTabFromInput(cid, input);
          if (resolved) {
            toolTabInfoStore.set(options.toolCallId, {
              tabId: resolved.tabId,
              title: resolved.tab.title ?? "",
              favIconUrl: resolved.tab.favIconUrl,
            });
          }
          // Some tab tools produce a *new* tab (e.g. `navigate` called
          // without `tab` opens a fresh background tab; popup-creating
          // clicks may surface a new handle). Without this branch, the
          // pre-execute startCapture wouldn't have run (no input.tab to
          // resolve), so the new tab's page-load network/console events
          // would be missed entirely until the agent's NEXT tool call
          // against it. Arm capture for the result handle now.
          //
          // We gate on absence of `error` because failed tools may still
          // echo the input handle back; capture for an existing tab is a
          // no-op via idempotency, but we don't want to attach to a tab
          // a fresh failed-navigation may have left in a half-loaded state.
          //
          // Resolution is via the same path as resolveTabFromInput: handle
          // → ltid → ctid. If it doesn't resolve (stale handle, registry
          // miss), we silently skip — capture remains best-effort.
          const r = result as { tab?: unknown; error?: unknown } | null | undefined;
          if (
            r &&
            typeof r === "object" &&
            typeof r.tab === "string" &&
            r.error === undefined &&
            cid
          ) {
            const ltid = resolveTabHandle(cid, r.tab);
            const producedTabId = ltid != null ? tabRegistry.toChromeTabId(ltid) : null;
            if (producedTabId != null) {
              await startCapture(producedTabId).catch(() => {});
            }
          }
        }
        return result;
      } finally {
        if (options.abortSignal) {
          options.abortSignal.removeEventListener("abort", onAbort);
        }
        activeToolAbortControllers.delete(ac);
      }
    } catch (err) {
      const errResult = {
        error: err instanceof Error ? err.message : String(err),
      };
      toolResultStore.set(options.toolCallId, errResult);
      return errResult as TOutput;
    }
  };

  const onInputAvailable =
    approvalRequired && isTabTool
      ? async (opts: { input: unknown; toolCallId: string }) => {
          // Resolve the agent-supplied `tab` arg to a concrete tab so the
          // approval UI can show "Always allow on <site>". This runs before
          // the SDK transitions to `approval-requested`, so the UI sees the
          // origin on first render. Capture cid once at entry — see
          // resolveTabFromInput's contract.
          const cid = agentConversationId;
          const resolved = await resolveTabFromInput(cid, opts.input);
          if (!resolved) return;
          if (resolved.tab.id != null) {
            capturedTabIds.set(opts.toolCallId, resolved.tab.id);
          }
          if (resolved.tab.url) {
            try {
              capturedToolOrigins.set(
                opts.toolCallId,
                new URL(resolved.tab.url).origin,
              );
            } catch {
              // Non-URL-shaped value (e.g. about:blank); skip allowlist.
            }
          }
          if (resolved.tab.id != null) {
            toolTabInfoStore.set(opts.toolCallId, {
              tabId: resolved.tab.id,
              title: resolved.tab.title ?? "",
              favIconUrl: resolved.tab.favIconUrl,
            });
          }
        }
      : undefined;

  const toModelOutput = isImageTool
    ? ({ output }: { output: TOutput }) => {
        const imageDataUrl = (output as { imageDataUrl?: string })
          .imageDataUrl;
        if (!imageDataUrl) {
          // Tool errored, produced no image, or had its base64 data
          // stripped during compaction (`stripScreenshotsFromParts`
          // replaces the output with `{ removed: "..." }`).
          //
          // Returning `undefined` here used to delegate to the SDK's
          // default JSON serializer, but AI SDK v5 (`createToolModelOutput`)
          // now passes `undefined` straight through to the prompt, so
          // the resulting `tool-result` content has `output: undefined`
          // and `standardizePrompt`'s strict Zod validation throws
          // `AI_InvalidPromptError` on the next turn (visible to the
          // user as "Invalid prompt: messages do not match the
          // ModelMessage[] schema"). Emit an explicit JSON fallback
          // ourselves so every screenshot tool-result has a well-formed
          // `output` regardless of whether image data is present.
          return {
            type: "json" as const,
            value: output as JSONValue,
          };
        }
        const base64 = imageDataUrl.replace(/^data:image\/png;base64,/, "");
        return {
          type: "content" as const,
          value: [
            {
              type: "image-data" as const,
              data: base64,
              mediaType: "image/png",
            },
          ],
        };
      }
    : undefined;

  // ToolSet[string] is Tool<any, any> — the SDK's Tool type uses conditional
  // types that can't be satisfied with generic type parameters.
  return {
    description: t.description,
    inputSchema: t.parameters,
    // Tools throwing inside `execute` (e.g. navigate timing out) get caught
    // above and serialized as `{ error: string }`. The AI SDK validates the
    // returned value against `outputSchema`, so we widen the schema with an
    // error-shaped variant; otherwise validation rejects graceful failures
    // and surfaces a hard framework error in the UI.
    outputSchema: t.outputSchema
      ? t.outputSchema.or(z.object({ error: z.string() }))
      : undefined,
    strict: true,
    execute,
    needsApproval: needsApprovalWithHeadless,
    ...(onInputAvailable && { onInputAvailable }),
    ...(toModelOutput && { toModelOutput }),
  } as ToolSet[string];
}

export const activeToolAbortControllers = new Set<AbortController>();

export function resetAgentIndicator() {
  if (agentActive) {
    agentActive = false;
    notifyAgentStatus(false);
  }
  for (const ac of activeToolAbortControllers) {
    ac.abort();
  }
  activeToolAbortControllers.clear();
  // Detach the debugger from every attached tab. cdp-session is the single
  // owner of debugger state (capture runs on top of it), so a single
  // releaseAll here tears down both. Order matters: aborts ran BEFORE this
  // detach so any tool mid-flight in cdp-session unwinds cleanly first.
  // (cdp-session's sendCommand has its own self-healing retry on detach
  // mid-flight, so even a race here is recoverable.)
  releaseAllSessions();
}


/**
 * Per-conversation tail of in-flight usage writes. `recordToolUsageForStep`
 * is fire-and-forget (`void`-ed at the call site), so the async bodies of
 * consecutive `onStepFinish` callbacks can interleave on the
 * getConversation → merge → updateConversation read-modify-write. Chaining
 * each conversation's writes off the previous one guarantees every read sees
 * the prior write's result, so concurrent additions to
 * `usedConnectorIds`/`loadedSkillNames` can't clobber each other.
 */
const usageWriteQueues = new Map<string, Promise<void>>();

/**
 * Record the connectors and skills invoked in a finished agent step onto the
 * conversation row, so the Context card can show them live (without waiting
 * for end-of-turn message persistence). Fire-and-forget; failures are
 * swallowed. Main agent only — subagent steps are not recorded here.
 *
 * The read-merge-write is serialized per conversation via `usageWriteQueues`
 * so overlapping step-finish calls can't read stale state and overwrite each
 * other's additions. Concurrent writes to OTHER conversation fields (e.g.
 * todos) are preserved by `updateConversation`'s in-transaction re-read +
 * shallow merge.
 */
async function recordToolUsageForStep(
  conversationId: string | null,
  toolCalls: readonly { toolName: string; input?: unknown }[],
): Promise<void> {
  if (!conversationId || toolCalls.length === 0) return;

  const { connectorIds, skillNames } = scanToolUsage(toolCalls);
  if (connectorIds.length === 0 && skillNames.length === 0) return;

  const cid = conversationId;
  const persist = async (): Promise<void> => {
    try {
      const conv = await chatDb.getConversation(cid);
      if (!conv) return;
      const mergedConnectors = mergeDistinct(conv.usedConnectorIds, connectorIds);
      const mergedSkills = mergeDistinct(conv.loadedSkillNames, skillNames);

      // Note: we intentionally do NOT bump `updatedAt` here (unlike setTodos) —
      // recording tool usage shouldn't reorder conversations or trigger sidebar
      // churn on every step.
      const updates: {
        usedConnectorIds?: string[];
        loadedSkillNames?: string[];
      } = {};
      if (mergedConnectors) updates.usedConnectorIds = mergedConnectors;
      if (mergedSkills) updates.loadedSkillNames = mergedSkills;
      if (Object.keys(updates).length === 0) return; // nothing new

      await chatDb.updateConversation(cid, updates);
    } catch {
      // Best-effort; recording usage must never disrupt the agent loop.
    }
  };

  // Chain after any in-flight write for this conversation so reads always see
  // the latest persisted state.
  const prev = usageWriteQueues.get(cid) ?? Promise.resolve();
  const next = prev.then(persist);
  usageWriteQueues.set(cid, next);
  try {
    await next;
  } finally {
    // Drop the entry once this write is the queue tail (no later writes
    // chained behind it) to keep the map from growing unbounded.
    if (usageWriteQueues.get(cid) === next) {
      usageWriteQueues.delete(cid);
    }
  }
}

/**
 * Persist a token/cost usage snapshot onto the conversation row at
 * step-finish time, so the header Context popover can read it live.
 *
 * Serialized through the same per-conversation `usageWriteQueues` chain as
 * `recordToolUsageForStep` so the read-modify-write (needed to accumulate
 * `costUsd`) can't race other usage writes for the same conversation.
 * Best-effort; failures are swallowed and never disrupt the agent loop.
 *
 * `modelId` is the fully-qualified user-facing model key (provider:model,
 * e.g. "anthropic:claude-x") and `model` is its `ModelDefinition` (for
 * contextWindow + pricing). Both are passed by the caller from the
 * transport's closure — NOT read from the module-global `currentModelDef`,
 * which races across concurrent transports (e.g. a side-panel run and a
 * popup run on different models), mirroring the evaluator-model pinning
 * below.
 */
async function recordUsageForStep(
  conversationId: string | null,
  step: StepUsage,
  model: ModelDefinition | undefined,
  modelId: string,
): Promise<void> {
  if (!conversationId) return;
  // Nothing to record if the provider reported no tokens this step.
  if (step.inputTokens == null && step.outputTokens == null) return;

  const cid = conversationId;
  const persist = async (): Promise<void> => {
    try {
      const conv = await chatDb.getConversation(cid);
      if (!conv) return;
      const usage = nextUsageSnapshot(
        conv.usage,
        step,
        model,
        modelId,
        Date.now(),
      );
      // Like recordToolUsageForStep, we intentionally do NOT bump
      // `updatedAt` on the row — usage churn shouldn't reorder the sidebar.
      await chatDb.updateConversation(cid, { usage });
    } catch {
      // Best-effort; recording usage must never disrupt the agent loop.
    }
  };

  const prev = usageWriteQueues.get(cid) ?? Promise.resolve();
  const next = prev.then(persist);
  usageWriteQueues.set(cid, next);
  try {
    await next;
  } finally {
    if (usageWriteQueues.get(cid) === next) {
      usageWriteQueues.delete(cid);
    }
  }
}

/**
 * For a CUA subagent under `attached` isolation, the runner seeded the
 * parent's tab handle into the child session as `cuaTabHandle`. Recover it
 * so the CUA loop can resolve the live tab id.
 */
function firstSeededHandle(ctx: ToolContext): string | undefined {
  return ctx.session?.cuaTabHandle;
}

/**
 * Resolve the Computer Use (CUA) subagent's model against the registry and
 * report whether its provider is configured.
 *
 * Resolution priority (NO hardcoded fallback — a missing model means CUA is
 * simply not enabled):
 *   1. The user's explicit `cuaModel` setting (compound "providerId:modelId").
 *   2. The main agent's model IF it is itself a Claude computer-use model —
 *      it is already configured (the conversation is running), so this "just
 *      works" on direct Anthropic OR the AI Gateway.
 *
 * Returns the resolved registry provider + bare model id + the provider's
 * config, plus `configured` (all required config fields present). When no
 * model resolves, returns `{ configured: false }` with no model — the caller
 * treats this as "CUA disabled".
 */
function resolveCuaSelection(
  settings: Settings,
  providers: import("@/registry/providers/types").ProviderDefinition[],
  cuaModelSetting: string | undefined,
  agentModel: string,
):
  | {
      configured: boolean;
      modelId: string;
      provider: import("@/registry/providers/types").ProviderDefinition;
      actualModelId: string;
      config: Record<string, string>;
    }
  | { configured: false; modelId?: undefined } {
  const mainModelIsCua = !!agentModel && isAnthropicComputerUseModel(agentModel);
  const modelId = cuaModelSetting || (mainModelIsCua ? agentModel : undefined);
  if (!modelId) return { configured: false };

  const [providerId, ...idParts] = modelId.split(":");
  const actualModelId = idParts.length > 0 ? idParts.join(":") : modelId;
  const provider =
    (idParts.length > 0
      ? providers.find((p) => p.id === providerId)
      : undefined) ??
    providers.find((p) => p.models.some((m) => m.id === actualModelId));
  if (!provider) return { configured: false };

  const config = settings.providerConfigs[provider.id] ?? {};
  const required = provider.configSchema?.filter((f) => f.required) ?? [];
  const configured = required.every((f) => !!config[f.key]);
  return { configured, modelId, provider, actualModelId, config };
}

export async function createAgentTransport(
  settings: Settings,
  agentModel: string,
  spaceId: string | null = null,
  spaceName: string | null = null,
  conversationId: string | null = null,
  thinkingConfig?: {
    enabled: boolean;
    config?: import("../types").ThinkingConfig;
  },
  headless?: {
    /** Auto-approve approval-gated tools (no human present). */
    autoApprove: boolean;
  },
): Promise<ChatTransport<AgentUIMessage> | null> {
  if (!agentModel) return null;

  // Parse compound "<providerId>:<modelId>" emitted by the chat UI; fall
  // back to a flat lookup for legacy stored values that pre-date the
  // compound format.
  const [maybeProvider, ...modelIdParts] = agentModel.split(":");
  const actualModelId =
    modelIdParts.length > 0 ? modelIdParts.join(":") : agentModel;

  const { providers } = await import("@/registry/providers");
  const provider =
    (modelIdParts.length > 0
      ? providers.find((p) => p.id === maybeProvider)
      : undefined) ??
    providers.find((p) => p.models.some((m) => m.id === actualModelId));

  if (!provider) return null;

  // Normalized "<providerId>:<modelId>" key. `agentModel` may be a legacy
  // flat id (no provider segment); this always yields a qualified key so the
  // persisted ConversationUsage.modelId is consistent and resolvable.
  const qualifiedModelId = `${provider.id}:${actualModelId}`;

  const config = settings.providerConfigs[provider.id] ?? {};
  const requiredFields = provider.configSchema?.filter((f) => f.required) ?? [];
  if (!requiredFields.every((f) => !!config[f.key])) return null;

  const model = await provider.createLanguageModel(config, actualModelId);
  setCurrentAgentModel(model);

  // Tell the compaction trigger about the model's actual context window
  // and max-output budget. Without this, `needsCompaction()` falls back
  // to the conservative default (~100K usable tokens) regardless of
  // model capability — which fires `stopWhen` after a single step on
  // any conversation past 100K, producing the "agent stops after one
  // tool call" symptom on long-context models like Gemini 2.5 Flash
  // (1M window) or Claude Sonnet 4.5 (200K window).
  const modelDef = provider.models.find((m) => m.id === actualModelId);
  setCurrentModelDef(modelDef);

  // Headless (scheduled) run: register the per-conversation policy so the
  // tool wrapper's approval gate auto-approves (or the tool set excludes
  // approval-gated tools) for this conversation. Keyed by conversationId so
  // it doesn't affect interactive chats in the same realm.
  if (headless && conversationId) {
    setHeadlessRunPolicy(conversationId, {
      autoApprove: headless.autoApprove,
    });
  }

  // Resolve the evaluator model once at transport build time. When
  // settings.completionCheck.evaluatorModel is unset (the recommended
  // default), the gate uses THIS transport's executor model — same
  // model, fresh context window. We pin to the local `model` rather
  // than letting the gate fall back to the module-global
  // `currentAgentModel` so concurrent transports (e.g. side panel +
  // popup window) don't race when one calls `setCurrentAgentModel`
  // mid-stream of the other.
  let evaluatorLanguageModel: LanguageModel = model;
  const evaluatorModelId = settings.completionCheck?.evaluatorModel;
  if (evaluatorModelId) {
    try {
      const [evalProviderId, ...evalIdParts] = evaluatorModelId.split(":");
      const evalActualModelId =
        evalIdParts.length > 0 ? evalIdParts.join(":") : evaluatorModelId;
      const evalProvider =
        (evalIdParts.length > 0
          ? providers.find((p) => p.id === evalProviderId)
          : undefined) ??
        providers.find((p) => p.models.some((m) => m.id === evalActualModelId));
      if (evalProvider) {
        const evalConfig = settings.providerConfigs[evalProvider.id] ?? {};
        const evalRequired =
          evalProvider.configSchema?.filter((f) => f.required) ?? [];
        if (evalRequired.every((f) => !!evalConfig[f.key])) {
          evaluatorLanguageModel = await evalProvider.createLanguageModel(
            evalConfig,
            evalActualModelId,
          );
        } else {
          console.warn(
            `[completion-check] evaluator override ${evaluatorModelId} is not configured (missing required fields); falling back to executor model`,
          );
        }
      } else {
        console.warn(
          `[completion-check] evaluator override ${evaluatorModelId} did not resolve to a known provider; falling back to executor model`,
        );
      }
    } catch (err) {
      console.warn(
        "[completion-check] failed to construct evaluator override; falling back to executor model:",
        err,
      );
    }
  }

  // Resolve the curator model lazily on first use: settings.curatorModel
  // overrides; otherwise the background curator reuses this transport's
  // foreground model. Cached after first resolution.
  let curatorModelCache: LanguageModel | undefined;
  async function resolveCuratorModel(): Promise<LanguageModel> {
    if (curatorModelCache) return curatorModelCache;
    const id = agentSettings.curatorModel;
    if (!id) {
      curatorModelCache = model;
      return model;
    }
    try {
      const [cProviderId, ...cIdParts] = id.split(":");
      const cActualModelId = cIdParts.length > 0 ? cIdParts.join(":") : id;
      const cProvider =
        (cIdParts.length > 0
          ? providers.find((p) => p.id === cProviderId)
          : undefined) ??
        providers.find((p) => p.models.some((m) => m.id === cActualModelId));
      if (cProvider) {
        const cConfig = settings.providerConfigs[cProvider.id] ?? {};
        const cRequired =
          cProvider.configSchema?.filter((f) => f.required) ?? [];
        if (cRequired.every((f) => !!cConfig[f.key])) {
          curatorModelCache = await cProvider.createLanguageModel(
            cConfig,
            cActualModelId,
          );
          return curatorModelCache;
        }
        console.warn(
          `[curator] model override ${id} is not configured (missing required fields); falling back to foreground model`,
        );
      } else {
        console.warn(
          `[curator] model override ${id} did not resolve to a known provider; falling back to foreground model`,
        );
      }
    } catch (err) {
      console.warn(
        "[curator] failed to construct model override; falling back to foreground model:",
        err,
      );
    }
    curatorModelCache = model;
    return model;
  }

  const browserTools = createBrowserToolSet();

  // The completion-check evaluator runs WITHOUT tools — single-shot
  // `generateObject` against the conversation context and the captured
  // tool-call trace. The earlier with-tools mode was removed (it
  // dominated end-of-turn latency, and the dimensions that benefited
  // from it have since been retired). See `completion-check/evaluator.ts`.

  const mcpTools = getMcpRegistry().toSDKTools();

  const mcpToolsList = getMcpRegistry().getAllTools();
  const mcpStates = getMcpRegistry().getStates();
  let instructions = SYSTEM_PROMPT;

  // Resolve once whether the Computer Use (cua) subagent is enabled — i.e. a
  // computer-use model is configured (explicit setting, or the main model is
  // itself a configured Claude CUA model). This gates three things in lockstep:
  // the CUA delegation guidance below, the `cua` entry in the delegate tool's
  // description, and the delegate execute-time check.
  const agentSettings = await storage.getAgentSettings();
  const cuaSelection = resolveCuaSelection(
    settings,
    providers,
    agentSettings.cuaModel,
    agentModel,
  );
  const cuaEnabled = cuaSelection.configured;

  // Only inject the CUA delegation guidance when CUA is actually usable —
  // otherwise the model sees instructions for a subagent it can't delegate to.
  if (cuaEnabled) {
    instructions += `\n\n${CUA_DELEGATION_PROMPT}`;
  }

  if (spaceId && spaceName) {
    instructions += `\n\nYou are chatting from the space "${spaceName}" (id: ${spaceId}). When saving space-scoped memories, use this spaceId.`;
  }

  // Completion check: every final assistant response is reviewed by a
  // separate skeptical evaluator before reaching the user. On
  // rejection, a synthetic user-role message prefixed with
  // "[Completion check]" is appended to the executor's context with
  // the concerns to address. The prompt section below tells the
  // executor (a) that the check happens, (b) how to recognize the
  // synthetic feedback, and (c) what to do with it.
  //
  // Always injected — the check is always-on and there is no
  // user-facing toggle.
  instructions += `\n\n## Completion checks

Your final response (text emitted without a tool call) will be reviewed by a skeptical evaluator before the user sees it. If the evaluator finds the response incomplete or unsupported, it will reject and you will receive a synthetic user-role message starting with the prefix \`[Completion check]\` containing structured concerns.

When you receive a \`[Completion check]\` message, treat it as a continuation directive, not a fresh user request. Address each listed concern by taking whatever tool calls are needed, then produce a corrected final response. Do not respond with apologies or restatements; just fix the gaps and continue.

Concerns are tagged by dimension:
- **completeness**: the response did not fulfill the original request end-to-end.
- **planClosure**: open todos contradict the claim of completion.
- **noPrematureHandoff**: the response punts work back to the user that was within scope.

To minimize wasted rejection rounds: before producing a final response, re-read the original request and confirm your todo list is fully closed out (or that every still-open todo has an explicit reason to remain open).`;

  // Inject current todo plan into system prompt
  const conv = agentConversationId
    ? await chatDb.getConversation(agentConversationId)
    : null;
  if (conv?.todos && conv.todos.length > 0) {
    instructions += `\n\n### Current Plan (todoWrite)\n`;
    const inProgress = conv.todos.find((t) => t.status === "in_progress");
    const completed = conv.todos.filter((t) => t.status === "completed").length;
    instructions += `Total tasks: ${conv.todos.length} (${completed} completed)\n`;
    if (inProgress) {
      instructions += `Currently working on: ${inProgress.content}\n`;
    } else {
      instructions += `No task currently marked in_progress.\n`;
    }
    instructions += `\nFull list:\n`;
    instructions += conv.todos
      .map((t, i) => `${i + 1}. [${t.status.toUpperCase()}] ${t.content}`)
      .join("\n");
  }

  // The tab legend is intentionally NOT appended to `instructions` here.
  // ownedLtids and tab URLs change mid-conversation (navigate adds a tab,
  // user closes a tab, etc.); a static legend baked at transport-construction
  // time would go stale. Instead we build it just-in-time inside `prepareCall`
  // below so every model call sees the live state.

  const memories = await memoryDb.list(spaceId);
  if (memories.length > 0) {
    const memoryList = memories
      .map((m) => `- [${m.type}] ${m.title}: ${m.description}`)
      .join("\n");
    instructions += MEMORY_INSTRUCTIONS;
    instructions += `\n### Current memories\n${memoryList}\n`;
  } else {
    instructions += MEMORY_INSTRUCTIONS;
    instructions += `\n### Current memories\n(none saved yet)\n`;
  }

  if (mcpToolsList.length > 0) {
    const mcpSection = mcpToolsList
      .map((t) => `- ${t.name} (${t.serverName}): ${t.description}`)
      .join("\n");
    instructions += `\n\nYou also have access to external tools from connected MCP servers:\n${mcpSection}\nUse these when the user's request matches their capabilities.`;
  }

  const allResources = mcpStates
    .filter((s) => s.status === "connected")
    .flatMap((s) => s.resources);
  if (allResources.length > 0) {
    const resourceSection = allResources
      .map((r) => `- ${r.name} (${r.serverName}): ${r.description} [${r.uri}]`)
      .join("\n");
    instructions += `\n\nAvailable MCP resources (use mcp_read_resource tool to access):\n${resourceSection}`;

    mcpTools["mcp_read_resource"] = tool({
      description: "Read content from an MCP resource by URI",
      inputSchema: z.object({
        serverId: z.string().describe("The server ID that owns the resource"),
        uri: z.string().describe("The resource URI to read"),
      }),
      execute: async (input) => {
        const response = await sendMcpMessage({
          type: "MCP_READ_RESOURCE",
          serverId: input.serverId,
          uri: input.uri,
        });
        if (!response.ok) throw new Error(response.error);
        return response.result;
      },
    });
  }

  const allPrompts = mcpStates
    .filter((s) => s.status === "connected")
    .flatMap((s) => s.prompts);
  if (allPrompts.length > 0) {
    const promptSection = allPrompts
      .map((p) => `- ${p.name} (${p.serverName}): ${p.description}`)
      .join("\n");
    instructions += `\n\nAvailable MCP prompts (use mcp_get_prompt tool to invoke):\n${promptSection}`;

    mcpTools["mcp_get_prompt"] = tool({
      description: "Get a prompt template from an MCP server",
      inputSchema: z.object({
        serverId: z.string().describe("The server ID that owns the prompt"),
        promptName: z.string().describe("The prompt name"),
        args: z
          .record(z.string(), z.string())
          .optional()
          .describe("Arguments for the prompt"),
      }),
      execute: async (input) => {
        const response = await sendMcpMessage({
          type: "MCP_GET_PROMPT",
          serverId: input.serverId,
          promptName: input.promptName,
          args: input.args,
        });
        if (!response.ok) throw new Error(response.error);
        return response.result;
      },
    });
  }

  // --- Skills Injection ---
  await getSkillsRegistry().init();
  const skillsState = getSkillsRegistry().getState();

  // Apply global enabled flag + per-space allow/deny override. Site skills are
  // EXCLUDED here — they're per-domain and surfaced in the auto-injected
  // "## Site skills for open tabs" legend block (only for currently-open
  // domains), not in the always-on general skills catalog.
  const availableSkills = skillsState.skills.filter((skill) => {
    if (skill.kind === "site") return false;
    // Global toggle (defaults to enabled if undefined for backward compat)
    if (skill.enabled === false) return false;
    const spaceConfig = skillsState.spaceConfigs.find(
      (c) => c.spaceId === spaceId && c.skillName === skill.name,
    );
    return !spaceConfig || spaceConfig.state !== "deny";
  });

  if (availableSkills.length > 0) {
    const skillsSection = availableSkills
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");

    instructions += `\n\n## Available Skills\n\nYou have access to the following skills. Each skill is knowledge you can load on demand. When a user's request matches a skill's description, call skill({ name }) to load its full instructions into the conversation.\n\n${skillsSection}\n\nTo install a new skill from a URL or GitHub repo, use install_skill({ source }).\nTo read a file bundled with a skill, use Read({ file_path }) with the skill's path (e.g. "/skills/<name>/references/<file>").\nTo author and install a new skill you've drafted for the user, use create_skill.`;
  }

  // Compose the parent's full tool set BEFORE constructing `runSubagentAgentLoop`,
  // because the loop filters from this set when building the subagent's tools.
  const parentTools = { ...browserTools, ...mcpTools };

  // Tools available ONLY inside a subagent run — never exposed to the
  // parent. `setTaskTitle` is the lone entry: it's how a subagent
  // updates the trace title shown in the parent's `DelegateResult`
  // block, but the parent itself has no use for it.
  const subagentOnlyTools: Record<string, ToolSet[string]> = {
    setTaskTitle: toSDKTool(setTaskTitleTool, "setTaskTitle"),
  };

  let providerOptions: ToolLoopAgentSettings["providerOptions"];
  if (thinkingConfig?.enabled && thinkingConfig.config) {
    // Resolve the underlying vendor (handles both direct providers and
    // gateway-routed `vendor/model` ids) and build the vendor-keyed options.
    // For Gemini this also picks `thinkingLevel` (Gemini 3) vs `thinkingBudget`
    // (Gemini 2.5) and sets `includeThoughts` so reasoning summaries stream
    // back. See `./thinking` for the full dispatch.
    providerOptions = buildThinkingProviderOptions(
      provider.id,
      actualModelId,
      thinkingConfig.config,
    ) as ToolLoopAgentSettings["providerOptions"];
  }

  // The runner that the `delegate` tool uses to actually spawn a nested
  // ToolLoopAgent. Closes over `model`, `parentTools`, and `providerOptions`;
  // the runner filters tools per the subagent's `allowedTools` and always
  // strips `delegate` (depth cap = 1).
  //
  // Streaming + persistence:
  //   - For peer / incognito runs (`childConversationId` is set), we
  //     consume the SDK's UIMessage stream via `readUIMessageStream` and
  //     persist each meaningful tick under the child conversation. This
  //     means clicking "Open child →" shows the subagent's full transcript
  //     using the existing chat rendering — no new UI components needed.
  //   - For inline runs (`childConversationId` is null), we still stream
  //     so the loop progresses, but skip persistence — inline subagent
  //     messages would interleave with the parent's chat in a confusing
  //     way. Inline runs surface as the parent's `DelegateResult` block;
  //     a follow-up phase will populate that block with the subagent's
  //     tool trace via a different mechanism (Fix B).
  //
  // The `parent` block on the child's session marks the run as a
  // subagent so the depth cap can fire if anything tries to call
  // `delegate` again.
  const runSubagentAgentLoop = async (
    cfg: AgentLoopConfig,
  ): Promise<AgentLoopResult> => {
    // CUA path: a custom-tool subagent runs a provider-native computer-use
    // loop instead of the standard filtered ToolLoopAgent.
    if (
      cfg.agentDef.toolSource === "custom" &&
      cfg.agentDef.custom?.kind === "cua"
    ) {
      // The attached isolation seeded the parent tab handle into this
      // session's handle map. Resolve it through the registry to a live
      // chrome tab id; the CUA loop's CDP commands take ctids.
      //
      // Even after the resolution here, the loop calls
      // `tabRegistry.toChromeTabId(ltid)` immediately before each action
      // so a `chrome.tabs.onReplaced` mid-loop is followed transparently
      // (the ltid is stable across replacements; only the ctid changes).
      const handle = firstSeededHandle(cfg.toolContext);
      const ltid = handle
        ? cfg.toolContext.session?.resolveHandle?.(handle)
        : undefined;
      // resolveHandle returns LogicalTabId (string) post-migration. The
      // bench harness has no session at all here.
      const tabId =
        typeof ltid === "string"
          ? tabRegistry.toChromeTabId(ltid) ?? null
          : ltid ?? null;
      if (tabId == null) {
        // Strict: never silently guess a tab. Return an actionable
        // instruction to the PARENT agent (this finalText flows back as the
        // delegate tool result) so it self-corrects on the next turn.
        const finalText = handle
          ? `Could not start the Computer Use agent: the tab handle "${handle}" is not bound to this conversation. Re-call delegate({ slug: "cua", context: { parentTabHandle: "<handle>" } }) with a handle from the current tab legend (call listTabs to refresh it).`
          : `Could not start the Computer Use agent: no tab was specified. Re-call delegate({ slug: "cua", context: { parentTabHandle: "<handle>" } }) with the handle (e.g. "t1") of the tab to control, taken from the tab legend or listTabs.`;
        return {
          finalText,
          status: "failed",
          errorMessage: handle
            ? "cua parent tab handle did not resolve"
            : "no parent tab handle for CUA",
        };
      }

      // Resolve the CUA subagent's model + configured provider via the same
      // helper that computed `cuaEnabled` at transport-build time, so the
      // delegate gate and the actual run can never disagree. Priority:
      //   1. The user's explicit `cuaModel` setting.
      //   2. The main agent's model IF it's a Claude computer-use model.
      // There is NO hardcoded fallback: an unresolved/unconfigured model
      // means Computer Use is not enabled.
      const sel = resolveCuaSelection(
        settings,
        providers,
        agentSettings.cuaModel,
        agentModel,
      );
      if (!sel.modelId || !sel.configured) {
        return {
          finalText:
            "Computer Use is not enabled. Select a computer-use model in Settings → General → Computer Use model (e.g. anthropic:claude-sonnet-4-6, or your gateway's Claude model), then retry.",
          status: "failed",
          errorMessage: "cua not configured",
        };
      }
      const cuaRegistryProvider = sel.provider;
      const cuaActualModelId = sel.actualModelId;
      const cuaConfig = sel.config;

      let cuaProvider;
      let cuaModel;
      try {
        cuaProvider = resolveCuaProvider(
          cuaRegistryProvider.id,
          cuaActualModelId,
          cuaConfig,
        );
        cuaModel = await cuaRegistryProvider.createLanguageModel(
          cuaConfig,
          cuaActualModelId,
        );
      } catch (err) {
        return {
          finalText: err instanceof Error ? err.message : String(err),
          status: "failed",
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }

      // Persist the delegation prompt as the child's first user message
      // BEFORE running, mirroring the standard subagent path.
      if (cfg.childConversationId) {
        try {
          await persistDelegationMessage(
            cfg.childConversationId,
            cfg.userMessage,
          );
        } catch {
          // best-effort
        }
      }

      // Persist each assistant message AS IT STREAMS so the subagent's
      // trace renders in real time in the parent's DelegateResult block
      // (rather than appearing in bulk only after the run finishes). Writes
      // are serialized through a promise chain to preserve order without
      // blocking the loop's iteration. `onUiMessage` fires per streamed
      // message; we upsert by id via the shared persister.
      const cuaPersister = cfg.childConversationId
        ? new AssistantStreamPersister(cfg.childConversationId)
        : null;
      let persistChain: Promise<void> = Promise.resolve();

      const result = await cuaProvider.runLoop({
        model: cuaModel,
        driver: extensionDriver,
        tabId,
        modelId: cuaActualModelId,
        task: cfg.userMessage,
        systemPrompt: cfg.systemPrompt,
        maxSteps: cfg.agentDef.maxSteps ?? 40,
        ...(cfg.abortSignal && { abortSignal: cfg.abortSignal }),
        onUiMessage: (m) => {
          if (!cuaPersister) return;
          persistChain = persistChain
            .then(() => cuaPersister.persist(m as AgentUIMessage))
            .catch(() => {
              // best-effort — finalText still returns to the parent
            });
        },
      });

      // Wait for any in-flight persists to land before returning.
      await persistChain;

      return result;
    }

    const subagentTools: Record<string, ToolSet[string]> = {};
    const allow = new Set(cfg.agentDef.allowedTools);
    const deny = new Set(cfg.agentDef.deniedTools ?? []);
    // Subagent tools come from two sources:
    //   1. Parent's tool set (minus `delegate`, depth cap=1).
    //   2. Subagent-only tools like `setTaskTitle` that have no parent
    //      use case.
    // Both sources go through the same allowedTools / deniedTools filter
    // so an agent definition can opt out of either.
    for (const [name, sdkTool] of Object.entries({
      ...parentTools,
      ...subagentOnlyTools,
    })) {
      if (name === "delegate") continue; // depth cap
      if (!allow.has(name)) continue;
      if (deny.has(name)) continue;
      subagentTools[name] = sdkTool;
    }

    const maxSteps = cfg.agentDef.maxSteps ?? 30;
    let stepCount = 0;

    const subagent = new ToolLoopAgent({
      model,
      tools: subagentTools,
      instructions: cfg.systemPrompt,
      ...(providerOptions && { providerOptions }),
      experimental_context: cfg.toolContext,
      onStepFinish: () => {
        stepCount += 1;
      },
      stopWhen: stepCountIs(maxSteps),
    });

    // Persist the synthesized delegation prompt as the first user
    // message in the child conversation BEFORE we start the model loop —
    // so a user opening the child mid-run sees the task spec the
    // subagent received even if no assistant tokens have streamed yet.
    if (cfg.childConversationId) {
      try {
        await persistDelegationMessage(
          cfg.childConversationId,
          cfg.userMessage,
        );
      } catch (err) {
        console.warn(
          "[subagents] persistDelegationMessage failed:",
          err,
        );
        // Continue — UI will be missing the user message but the
        // assistant transcript still renders.
      }
    }

    try {
      const streamResult = await subagent.stream({
        prompt: cfg.userMessage,
        ...(cfg.abortSignal && { abortSignal: cfg.abortSignal }),
      });

      // The UI message stream — same shape `useAgentChat` consumes for
      // the parent — gives us per-step UIMessages (tool calls, text
      // deltas, step markers) we can serialize and persist.
      const uiMessageStream = streamResult.toUIMessageStream();
      const uiMessages = readUIMessageStream<AgentUIMessage>({
        stream: uiMessageStream,
      });

      // Drain the stream once: persist the transcript and return an
      // `AssistantStreamResult` with the captured transcript so we can
      // ship it back to the parent's DelegateResult block uniformly.
      //
      // Defensive guard: `AgentLoopConfig.childConversationId` is typed
      // as `string | null` because callers may want to pass null for
      // detached/inline runs. The current caller (runner.ts) always
      // passes a non-null id, but we assert here so a future caller
      // that forgets gets a clear error instead of silent persistence
      // under an `undefined` conversation key.
      if (!cfg.childConversationId) {
        throw new Error(
          "childConversationId required for persistAssistantStream",
        );
      }
      const drained = await persistAssistantStream({
        childConversationId: cfg.childConversationId,
        uiMessages,
      });

      const finalText =
        drained.finalText.trim().length > 0
          ? drained.finalText
          : `(no final text returned; subagent ran ${stepCount} step(s))`;
      const status: AgentLoopResult["status"] =
        stepCount >= maxSteps && drained.finalText.length === 0
          ? "budget-exceeded"
          : "completed";
      return { finalText, status, transcript: drained.transcript };
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || /aborted/i.test(err.message));
      if (isAbort) {
        return {
          finalText: "(subagent cancelled)",
          status: "cancelled",
          errorMessage: "aborted",
        };
      }
      throw err;
    }
  };

  const delegateTool = createDelegateTool({
    runAgentLoop: runSubagentAgentLoop,
    cuaEnabled,
  });

  const tools = (() => {
    const base = {
      ...parentTools,
      delegate: toSDKTool(delegateTool, "delegate"),
    };
    if (!headless) return base;
    // Headless (scheduled) run: never spawn subagents. When not
    // auto-approving, also drop approval-gated tools (no human to approve).
    //
    // `executePython` is intentionally NOT in this drop list: its approval
    // is network-conditional (see the `needsApproval` branch above), so a
    // sandboxed run needs no approval and is safe to keep available. We
    // instead force `allow_network: false` for it in the execute wrapper
    // during non-auto-approve headless runs, so the model can't reach the
    // network without a human in the loop.
    const HEADLESS_DROP = new Set<string>(["delegate"]);
    if (!headless.autoApprove) {
      for (const k of [
        "closeTabs",
        "executeOnPage",
        "updateMemory",
        "Delete",
        "install_skill",
        "create_skill",
      ]) {
        HEADLESS_DROP.add(k);
      }
    }
    // Scheduled runs must never create/modify scheduled tasks (no recursion).
    HEADLESS_DROP.add("create_scheduled_task");
    HEADLESS_DROP.add("list_scheduled_tasks");
    HEADLESS_DROP.add("update_scheduled_task");
    const filtered: Record<string, ToolSet[string]> = {};
    for (const [name, sdkTool] of Object.entries(base)) {
      if (HEADLESS_DROP.has(name)) continue;
      filtered[name] = sdkTool;
    }
    return filtered;
  })();

  // Per-stream "needs mid-stream compaction" signal. Set by `onStepFinish`
  // when token usage crosses the threshold; read by `stopWhen` to break
  // the loop after the current step completes (matching OpenCode's
  // step-boundary behavior). Cleared at the start of each `sendMessages`
  // by the wrapper transport so a previous turn's signal doesn't leak.
  let needsMidStreamCompaction = false;

  // Site-skill catalog snapshot, refreshed each turn in buildLegendBlock and
  // read by the curator-enqueue in onCompletionCheckApproved. `lastActiveUrl`
  // attributes candidates to a domain; `lastCatalogDomains` gates extraction.
  let lastCatalogDomains: string[] = [];
  let lastActiveUrl: string | undefined;
  let lastTurnConversationId: string | null = null;
  // Persisted-message count captured at gate time (before this turn's
  // assistant message is written to chat-db). The curator-enqueue uses it as a
  // baseline to wait for the assistant message to land before reading the full,
  // untruncated UIMessages from chat-db — the only source carrying complete
  // executeOnPage tool inputs/outputs. The completion-check builder's
  // `sendMessages` are the *input* messages (just the user turn on turn 1), and
  // the tool-call trace is hard-truncated, so neither can reconstruct a
  // reusable script.
  let lastTurnBaselineCount = 0;

  /**
   * Wait until this turn's assistant message lands in chat-db (count exceeds
   * `lastTurnBaselineCount`), bound to the live `chatDb` pubsub. Delegates to
   * the unit-tested `waitForAssistantPersist` helper. See its module doc for
   * why the curator must wait before reading persisted messages.
   */
  function waitForAssistantPersist(
    cid: string,
    baselineCount: number,
    timeoutMs = 5000,
  ): Promise<number> {
    return waitForAssistantPersistImpl(
      {
        getMessageCount: (c) => chatDb.getMessageCount(c),
        subscribeMessageChange: (l) => chatDb.subscribeMessageChange(l),
      },
      cid,
      baselineCount,
      timeoutMs,
    );
  }

  /**
   * Build the dynamic "## Tabs in this conversation" block plus an
   * awareness-only "## Other open tabs" block from live state. Re-reads
   * ownedLtids from chatDb and queries chrome.tabs each call so the
   * agent sees the current tab set on every turn (not the snapshot
   * baked at transport-construction time).
   *
   * The awareness block lists tabs the user has open in the current
   * window that are NOT bound to this conversation. The agent must
   * `selectTab({ tab })` before passing those handles to tab-acting
   * tools — handles in the awareness block are read-only context.
   */
  async function buildLegendBlock(): Promise<string> {
    const cid = agentConversationId;
    if (!cid) return "";
    const liveConv = await chatDb.getConversation(cid);
    const ownedLtids = liveConv?.ownedLtids ?? [];
    const entries = await buildTabLegendEntries({
      conversationId: cid,
      ownedLtids,
      // The legend keys on LogicalTabIds. Resolve each ltid to a live
      // chrome tab id via the registry just before fetching the tab info;
      // unresolvable ltids (the underlying tab is gone) trigger the
      // legend renderer's "drop this entry" branch via the rejected
      // promise.
      getTab: async (ltid) => {
        const ctid =
          typeof ltid === "string" ? tabRegistry.toChromeTabId(ltid) : Number(ltid);
        if (ctid == null) {
          throw new Error(
            `LogicalTabId ${String(ltid)} no longer maps to a live chrome tab`,
          );
        }
        const tab = await chrome.tabs.get(ctid);
        return { url: tab.url, title: tab.title };
      },
      getOrCreateHandle: (c, ltid) =>
        // ltid is already a string; pass through. Defensive Number() for
        // the bench harness path where ids may be numeric.
        getOrCreateTabHandle(
          c,
          typeof ltid === "string" ? ltid : tabRegistry.registerExisting(Number(ltid)),
        ),
      // `getTargetTabId` returns a live ctid; map back to the matching
      // ltid so the legend's `active` comparison (which is `ltid === ltid`)
      // works correctly.
      activeTabId: (() => {
        const activeCtid = getTargetTabId();
        if (activeCtid == null) return null;
        return tabRegistry.toLogicalTabId(activeCtid) ?? null;
      })(),
    });
    const ownedBlock = renderTabLegend(entries);

    // Awareness block: enumerate user's other open tabs in the current
    // window. Reuses the driver's listTabs (already filters internal
    // URLs and scopes to current window). Errors here must not break
    // the legend — fall back to the owned-only block. We also collect the
    // open-tab URLs here so the site-skill catalog below can consider the
    // domain of the tab the user is actually looking at — which is typically
    // an UNOWNED/awareness tab ("go to my LinkedIn"), not one we navigated to.
    let awarenessBlock = "";
    const openTabUrls: string[] = [];
    let activeOpenUrl: string | undefined;
    try {
      const openTabs = await extensionDriver.listTabs();
      for (const t of openTabs) {
        if (t.url) openTabUrls.push(t.url);
        // Track the user's ACTIVE tab URL specifically — the curator attributes
        // candidates to this domain. listTabs() order is not active-first, so
        // we must read the `active` flag rather than assume openTabUrls[0].
        if (t.active && t.url) activeOpenUrl = t.url;
      }
      const { entries: awarenessEntries, truncated } =
        buildOpenTabsAwarenessEntries({
          conversationId: cid,
          ownedLtids,
          // Convert each open tab's chrome ctid into an ltid via the
          // registry so the awareness block keys on the same identifier
          // namespace as the owned block. New tabs the agent hasn't
          // bound yet get a freshly-minted ltid here (idempotent).
          openTabs: openTabs.map((t) => ({
            id: tabRegistry.registerExisting(Number(t.id)),
            url: t.url,
            title: t.title,
            active: !!t.active,
          })),
          getOrCreateHandle: (c, ltid) =>
            getOrCreateTabHandle(
              c,
              typeof ltid === "string"
                ? ltid
                : tabRegistry.registerExisting(Number(ltid)),
            ),
        });
      awarenessBlock = renderOpenTabsAwareness(awarenessEntries, truncated);
    } catch {
      // No window / chrome.tabs unavailable; skip awareness block.
    }

    // Domain-aware context: for each unique domain among ALL open tabs (owned
    // + the user's other open tabs), surface its site skill if one exists, or
    // a "no site skill yet" bootstrap line if not, so the reuse/save loop is
    // visible. Owned URLs alone are insufficient — the active tab is usually
    // unowned. Best-effort — never break the legend over a registry hiccup.
    const allOpenUrls = [...entries.map((e) => e.url), ...openTabUrls];
    // Stash the catalog snapshot for the curator-enqueue
    // (onCompletionCheckApproved). Computed OUTSIDE the registry try-clause
    // below so a registry hiccup can't wipe it. `lastActiveUrl` is the user's
    // actual active tab (not openTabUrls[0]); fall back to first owned only if
    // no active tab was found.
    lastCatalogDomains = allOpenUrls
      .map((u) => urlToDomain(u))
      .filter((d): d is string => !!d);
    lastActiveUrl = activeOpenUrl ?? entries[0]?.url;
    let domainBlock = "";
    try {
      await getSkillsRegistry().init();
      const siteSkills = getSkillsRegistry()
        .getState()
        .skills.filter((s) => s.kind === "site");
      domainBlock = renderSiteSkillsBlock(allOpenUrls, siteSkills);
    } catch {
      // leave domainBlock empty
    }

    return [ownedBlock, awarenessBlock, domainBlock].filter(Boolean).join("\n\n");
  }

  const agent = new ToolLoopAgent({
    model,
    tools,
    instructions,
    ...(providerOptions && { providerOptions }),
    // Note: we deliberately do NOT thread an `experimental_context` here.
    // Every tool registered with this agent is wrapped by `toSDKTool`,
    // which builds a fresh `ToolContext` per tool call pinned to the
    // conversation id captured synchronously at execute-entry. This
    // guarantees pinning at the per-tool-call grain, which is the only
    // grain that survives mid-stream conversation switches.
    // Append a fresh tab legend on every model call. The SDK invokes
    // prepareCall right before each generate/stream, so this picks up
    // tabs added by `navigate`, removed by closure, etc. — even
    // mid-conversation.
    prepareCall: async (callArgs) => {
      const legend = await buildLegendBlock();
      const baseInstructions =
        typeof callArgs.instructions === "string" ? callArgs.instructions : "";
      return {
        ...callArgs,
        instructions: legend
          ? `${baseInstructions}\n\n${legend}`
          : baseInstructions,
      };
    },
    onStepFinish: (stepResult) => {
      const usage = stepResult.usage;
      if (usage.inputTokens != null || usage.outputTokens != null) {
        lastTotalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      }
      // Once needsCompaction() reports true, set the flag so stopWhen
      // breaks the loop at the next step boundary. We don't unset on a
      // false read — once we've decided to compact, see the decision
      // through.
      if (needsCompaction()) {
        needsMidStreamCompaction = true;
      }
      // Record connectors/skills used this step onto the conversation row so
      // the Context card surfaces them live (mirrors how todoWrite persists
      // todos mid-turn, instead of waiting for end-of-turn message persistence).
      void recordToolUsageForStep(agentConversationId, stepResult.toolCalls);
      // Persist the token/cost usage snapshot for the header Context popover.
      // Fire-and-forget; serialized per-conversation alongside tool usage.
      void recordUsageForStep(agentConversationId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }, modelDef, qualifiedModelId);
    },
    stopWhen: () => needsMidStreamCompaction,
  });

  return new CompactingChatTransport({
    agent,
    onSendStart: () => {
      needsMidStreamCompaction = false;
      // Reset the curator turn-snapshot so a turn where buildLegendBlock /
      // buildCompletionCheckInput don't repopulate them (e.g. a transient,
      // non-persisted run) can't enqueue a curator job off a prior turn's
      // stale data. They're repopulated below during this turn if applicable.
      lastTurnConversationId = null;
      lastTurnBaselineCount = 0;
      lastCatalogDomains = [];
      lastActiveUrl = undefined;
    },
    // Capture the active cid synchronously at the top of every
    // `sendMessages`. The transport pins it for the duration of the loop
    // and threads it to `buildCompletionCheckInput`, so a mid-stream
    // `setAgentContext(other)` cannot redirect the gate's chatDb reads.
    getActiveConversationId: () => agentConversationId,
    // Wire the completion-check gate. Returns `undefined` when no
    // conversationId is bound, so the gate sits dormant for transient
    // (non-persisted) runs (e.g. the chat title generator).
    buildCompletionCheckInput: async ({
      sendMessages,
      finalText,
      toolCallTrace,
      pinnedConversationId,
    }) => {
      const cid = pinnedConversationId;
      if (!cid) return undefined;

      // Stash this turn's baseline for the curator-enqueue, which runs in
      // onCompletionCheckApproved (same turn, after this builder). Captured
      // here because the approval callback only receives (cid, now). The
      // baseline is the persisted message count *before* this turn's assistant
      // message is written, so the enqueue can wait for it to land and then
      // read the full UIMessages (with executeOnPage tool parts) from chat-db.
      lastTurnConversationId = cid;
      try {
        lastTurnBaselineCount = await chatDb.getMessageCount(cid);
      } catch {
        lastTurnBaselineCount = 0;
      }

      // Last user-role message in the SDK message list is the original
      // request that drove this turn. Bail if for any reason there is
      // no user turn (defensive — the SDK shouldn't ever invoke
      // sendMessages without one).
      const lastUser = [...sendMessages]
        .reverse()
        .find((m) => m.role === "user");
      if (!lastUser) return undefined;
      const originalRequest = lastUser.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .trim();

      // Turn ordinal: count of user-role messages up to and including
      // the most recent one. 0-indexed for telemetry consistency with
      // arrays.
      const turnIndex = Math.max(
        0,
        sendMessages.filter((m) => m.role === "user").length - 1,
      );

      // Snapshot todos at gate time. The gate's trigger heuristic
      // (todos-or-tool-calls) needs this to decide whether to run.
      let todos: import("../types").TodoItem[] = [];
      try {
        const conv = await chatDb.getConversation(cid);
        todos = conv?.todos ?? [];
      } catch (err) {
        // Best-effort: if chat-db read fails, fall back to no todos.
        // The gate will likely skip but the user's response isn't
        // blocked.
        console.warn("[completion-check] todo lookup failed:", err);
      }

      return {
        conversationId: cid,
        turnIndex,
        // Rejection rounds are managed by the rejection loop in the
        // transport; the gate invocation here is always for the
        // current round, which the transport tracks.
        rejectionRound: 0,
        originalRequest,
        draftedResponse: finalText,
        todos,
        toolCallTrace,
        // Threaded once at transport build; null means "fall back to
        // the executor's current model" inside the evaluator.
        evaluatorModel: evaluatorLanguageModel,
      };
    },
    onCompletionCheckApproved: (cid, now) => {
      void persistCompletionMarker(cid, "approved", now);
      // Fire-and-forget: extract reusable site-skill candidates from this
      // turn and enqueue a background curator job. Never blocks the user's
      // response; failures are swallowed.
      void (async () => {
        try {
          if (lastTurnConversationId !== cid) {
            if (DEBUG_CURATOR)
              console.warn(
                "[curator] skip: conversation-id mismatch (stale turn snapshot)",
              );
            return;
          }
          // Wait for this turn's assistant message (carrying the executeOnPage
          // tool parts) to persist, then read the full, untruncated UIMessages
          // from chat-db. This is the only source with complete tool
          // inputs/outputs — the completion-check `sendMessages` are pre-turn
          // input only, and the tool-call trace is hard-truncated.
          await waitForAssistantPersist(cid, lastTurnBaselineCount);
          const persisted = await chatDb.getMessages(cid);
          const messages = persisted as unknown as {
            role: string;
            parts?: unknown[];
          }[];
          if (DEBUG_CURATOR) {
            console.error(
              `[curator] approved conv=${cid} catalogDomains=[${lastCatalogDomains.join(",")}] activeUrl=${lastActiveUrl ?? "?"} baseline=${lastTurnBaselineCount} persisted=${messages.length}`,
            );
          }
          if (!messages.length) {
            if (DEBUG_CURATOR)
              console.warn("[curator] skip: no persisted messages for turn");
            return;
          }
          const { extractSiteSkillCandidates, detectNotableActivityDomain } =
            await import("@/lib/skills/site-skill-candidates");
          const candidates = extractSiteSkillCandidates({
            messages,
            catalogDomains: lastCatalogDomains,
            activeUrl: lastActiveUrl,
          });
          // Notes-only trigger: even with no reusable script, a turn that hit
          // friction (errored/timed-out tool calls) on a catalog domain is
          // worth curating a durable site note for.
          const notableDomain = detectNotableActivityDomain({
            messages,
            catalogDomains: lastCatalogDomains,
            activeUrl: lastActiveUrl,
          });
          if (DEBUG_CURATOR)
            console.warn(
              `[curator] extracted ${candidates.length} candidate(s)${candidates.length ? ` for ${[...new Set(candidates.map((c) => c.domain))].join(",")}` : ""}${notableDomain ? ` notableActivity=${notableDomain}` : ""}`,
            );
          if (candidates.length === 0 && !notableDomain) return;
          const { enqueueCuratorJob } = await import("./curator/queue");
          const { drainCuratorQueue, runCuratorJob } = await import(
            "./curator/runner"
          );
          // Group candidates by domain (one job per domain). Seed the map with
          // the notable-activity domain so a notes-only job is enqueued even
          // when that domain produced no script candidate.
          const byDomain = new Map<string, typeof candidates>();
          if (notableDomain) byDomain.set(notableDomain, []);
          for (const c of candidates) {
            const arr = byDomain.get(c.domain) ?? [];
            arr.push(c);
            byDomain.set(c.domain, arr);
          }
          const toolHistory = JSON.stringify(
            messages.flatMap((m) => (m.parts ?? []) as unknown[]),
          ).slice(0, 20000);
          for (const [domain, cands] of byDomain) {
            await enqueueCuratorJob({
              conversationId: cid,
              domain,
              candidates: cands,
              toolHistory,
            });
          }
          if (DEBUG_CURATOR)
            console.warn(
              `[curator] enqueued ${byDomain.size} job(s) for [${[...byDomain.keys()].join(",")}]`,
            );
          // Build the curator's replay-only toolset: Read (scoped to /skills/)
          // + the RAW patch_site_skill (curator authors from scratch, so it
          // bypasses the foreground self-heal guard).
          const curatorFsTools = createFsTools();
          const curatorTools: ToolSet = {
            Read: toSDKTool(curatorFsTools.readTool, "Read"),
            patch_site_skill: toSDKTool(
              patchSiteSkillTool,
              "patch_site_skill",
            ),
          };
          const curatorModel = await resolveCuratorModel();
          void drainCuratorQueue({
            debug: DEBUG_CURATOR,
            runAgent: (jobToRun) =>
              runCuratorJob(jobToRun, {
                model: curatorModel,
                tools: curatorTools,
                debug: DEBUG_CURATOR,
              }),
          });
        } catch (err) {
          console.warn("[curator] enqueue/drain failed:", err);
        }
      })();
    },
  });
}
