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
import type {
  AgentLoopConfig,
  AgentLoopResult,
} from "./subagents/runner";
import {
  persistAssistantStream,
  persistDelegationMessage,
} from "./subagents/persist-stream";
import {
  getOrCreateHandle as getOrCreateTabHandle,
  loadHandlesForConversation,
  resolveHandle as resolveTabHandle,
} from "./tab-handles";
import { persistCompletionMarker } from "./persist-completion-marker";
import {
  buildTabLegendEntries,
  renderTabLegend,
  buildOpenTabsAwarenessEntries,
  renderOpenTabsAwareness,
} from "./tab-legend";
import {
  clickElementTool,
  closeTabsTool,
  createScheduledTaskTool,
  createSkillTool,
  deleteMemoryTool,
  executeCodeTool,
  executeOnPageTool,
  extractTool,
  installSkillTool,
  listScheduledTasksTool,
  listTabsTool,
  navigateTool,
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
} from "./tools";
import { createDelegateTool } from "./tools/delegate";
import { createFsTools } from "./tools/fs";
import { createPythonTool } from "./tools/execute-python";
import { setTaskTitleTool } from "./tools/set-task-title";
import type { BrowserTool } from "./types";

import { SYSTEM_PROMPT } from "./system-prompt";

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
- You learn per-site knowledge (navigation patterns, quirks) → save as site type
- You learn where external information lives → save as reference type

### Memory types
- **user**: Role, preferences, expertise. Free-form content.
- **feedback**: Behavior corrections or confirmations. Structure: rule, then **Why:** and **How to apply:** lines.
- **site**: Per-domain knowledge. Set the domain field. Free-form content.
- **reference**: Where to find things externally. Free-form content.

### Scoping: user vs. space memories
Memories are either global (user-level) or scoped to a specific space.

**Save as user memory (no spaceId)** when it applies everywhere:
- Identity, name, role, company
- Universal preferences and behavior corrections
- General site knowledge (e.g. "on GitHub, go to files-changed first")

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

const INDICATOR_CSS = `
  #openbrowse-agent-border {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 2147483646;
    margin: 0 !important; padding: 0 !important; transform: none !important;
    pointer-events: none;
    overflow: hidden;
  }
  .ob-glow {
    position: absolute;
    inset: -40px;
    filter: blur(40px);
    animation: ob-breathe 4s ease-in-out infinite;
    -webkit-mask:
      linear-gradient(to right, #fff 0px, transparent 100px, transparent calc(100% - 100px), #fff 100%),
      linear-gradient(to bottom, #fff 0px, transparent 100px, transparent calc(100% - 100px), #fff 100%);
    mask:
      linear-gradient(to right, #fff 0px, transparent 100px, transparent calc(100% - 100px), #fff 100%),
      linear-gradient(to bottom, #fff 0px, transparent 100px, transparent calc(100% - 100px), #fff 100%);
  }
  .ob-glow::before,
  .ob-glow::after {
    content: "";
    position: absolute;
    border-radius: 50%;
    background: radial-gradient(circle, var(--ob-c1, #3b82f6) 0%, transparent 70%);
  }
  .ob-glow::before {
    width: 50%; height: 60%;
    animation: ob-orbit1 8s ease-in-out infinite;
  }
  .ob-glow::after {
    width: 40%; height: 50%;
    opacity: 0.6;
    animation: ob-orbit2 8s ease-in-out infinite;
  }
  @keyframes ob-orbit1 {
    0% { top: -20%; left: 20%; }
    25% { top: 20%; left: 80%; }
    50% { top: 70%; left: 50%; }
    75% { top: 20%; left: -10%; }
    100% { top: -20%; left: 20%; }
  }
  @keyframes ob-orbit2 {
    0% { top: 60%; left: 70%; }
    25% { top: -10%; left: 40%; }
    50% { top: 10%; left: -5%; }
    75% { top: 70%; left: 30%; }
    100% { top: 60%; left: 70%; }
  }
  @keyframes ob-breathe {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }
  #openbrowse-agent-blocker {
    position: fixed; inset: 0; z-index: 2147483645; cursor: not-allowed;
  }
  #openbrowse-agent-toast {
    position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
    z-index: 2147483647; display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; border-radius: 8px;
    font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #fafafa; background: #18181b;
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: ob-toast-in 0.2s ease-out;
  }
  @media (prefers-color-scheme: light) {
    #openbrowse-agent-toast { color: #18181b; background: #fff; border: 1px solid #e4e4e7; }
    #openbrowse-agent-toast button { background: #18181b !important; color: #fafafa !important; }
  }
  @keyframes ob-toast-in { from{opacity:0;transform:translateX(-50%) translateY(8px)} to{opacity:1;transform:translateX(-50%) translateY(0)} }
  #openbrowse-agent-toast button {
    background: #fafafa; color: #18181b; border: none;
    padding: 4px 10px; border-radius: 4px;
    font-size: 12px; font-weight: 500; cursor: pointer; font-family: inherit;
  }
`;

function showIndicatorScript(color: string | null) {
  if (document.getElementById("openbrowse-agent-border")) return;
  const border = document.createElement("div");
  border.id = "openbrowse-agent-border";
  if (color) {
    border.style.setProperty("--ob-c1", color);
  }
  const glow = document.createElement("div");
  glow.className = "ob-glow";
  border.appendChild(glow);
  const blocker = document.createElement("div");
  blocker.id = "openbrowse-agent-blocker";
  const toast = document.createElement("div");
  toast.id = "openbrowse-agent-toast";
  const logoUrl = chrome.runtime.getURL("icon/logo.svg");
  toast.innerHTML = `<img src="${logoUrl}" style="width:18px;height:18px;border-radius:4px;"><span>OpenBrowse is working on this tab</span><button id="openbrowse-agent-stop">Stop</button>`;
  document.documentElement.appendChild(border);
  document.documentElement.appendChild(blocker);
  document.documentElement.appendChild(toast);
  document.getElementById("openbrowse-agent-stop")!.onclick = () => {
    chrome.runtime.sendMessage({ type: "AGENT_STOP" });
    document.getElementById("openbrowse-agent-border")?.remove();
    document.getElementById("openbrowse-agent-blocker")?.remove();
    document.getElementById("openbrowse-agent-toast")?.remove();
  };
}

function hideIndicatorScript() {
  document.getElementById("openbrowse-agent-border")?.remove();
  document.getElementById("openbrowse-agent-blocker")?.remove();
  document.getElementById("openbrowse-agent-toast")?.remove();
}

export async function injectIndicator(tabId: number, color?: string | null) {
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      css: INDICATOR_CSS,
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showIndicatorScript,
      args: [color ?? null],
    });
  } catch {
    // page not injectable (chrome://, etc.)
  }
}

async function removeIndicator(tabId: number) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: hideIndicatorScript,
    });
  } catch {
    // page not injectable
  }
}

export function notifyAgentStatus(
  working: boolean,
  color?: string | null,
  tabId?: number | null,
) {
  indicatorQueue = indicatorQueue.then(async () => {
    try {
      // The blocking indicator must land on the tab the agent's tool is
      // actually operating on — NOT whatever tab the user happens to be
      // focused on. When the agent works inside its owned tab group, the
      // user may be looking at a different (non-worked) tab in the same
      // window; targeting the active tab would inject the blocker onto
      // that innocent tab. So:
      //  - When working, require an explicit target tabId from the tool
      //    call. If none was resolved, skip injection entirely.
      //  - When idle, remove from the last tab we injected onto.
      const targetTabId = working
        ? (tabId ?? null)
        : (tabId ?? lastIndicatorTabId);
      if (targetTabId == null) {
        if (!working) lastIndicatorTabId = null;
        return;
      }
      let url = "";
      try {
        const tab = await chrome.tabs.get(targetTabId);
        url = tab.url ?? "";
      } catch {
        // Tab gone; nothing to inject/remove.
        if (!working) lastIndicatorTabId = null;
        return;
      }
      // Skip injection on internal pages (extension/chrome/devtools UI).
      if (
        url.startsWith("chrome://") ||
        url.startsWith("chrome-extension://") ||
        url.startsWith("devtools://")
      ) {
        return;
      }
      if (working) {
        // If the agent moved to a different tab within the same run,
        // clear the blocker from the previously-targeted tab so it
        // doesn't linger as a stale overlay. removeIndicator swallows
        // its own errors (e.g. tab gone / not injectable).
        if (lastIndicatorTabId != null && lastIndicatorTabId !== targetTabId) {
          await removeIndicator(lastIndicatorTabId);
        }
        lastIndicatorTabId = targetTabId;
        await injectIndicator(targetTabId, color);
      } else {
        lastIndicatorTabId = null;
        await removeIndicator(targetTabId);
      }
      chrome.runtime
        .sendMessage({
          type: working ? "AGENT_TAB_WORKING" : "AGENT_TAB_IDLE",
          tabId: targetTabId,
          color,
        })
        .catch(() => {});
    } catch {
      // no resolvable tab
    }
  });
}

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
]);

let agentActive = false;
let currentSpaceColor: string | null = null;
let indicatorQueue: Promise<void> = Promise.resolve();
/**
 * The tab the blocking indicator was last injected onto, so an idle
 * notification (which may not carry a tabId) can remove it from the
 * correct tab rather than the user's currently-focused one.
 */
let lastIndicatorTabId: number | null = null;

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

export function setAgentSpaceColor(color: string | null) {
  currentSpaceColor = color;
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
 * Resolve the target tab ids for a closeTabs input against the
 * conversation's owned tabs.
 */
async function resolveCloseTabsTargetIds(
  conversationId: string,
  input: { target: "group" } | { target: "tabs"; tabIds: number[] },
): Promise<number[]> {
  if (input.target === "group") {
    const conv = await chatDb.getConversation(conversationId);
    return conv?.ownedTabIds ?? [];
  }
  return input.tabIds;
}

/**
 * True when a closeTabs call may skip approval: the global flag is on AND
 * every target tab is in the conversation's ownedTabIds. Any non-owned
 * target forces manual approval regardless of the flag.
 */
export async function shouldAutoApproveCloseTabs(
  conversationId: string,
  input: { target: "group" } | { target: "tabs"; tabIds: number[] },
): Promise<boolean> {
  if (!(await isCloseTabsAlwaysAllowed())) return false;
  const conv = await chatDb.getConversation(conversationId);
  if (!conv) return false;
  const owned = new Set(conv.ownedTabIds);
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
 * Build the browser tool set for a conversation. Extracted from
 * `createAgentTransport` so the headless scheduled-run loop can reuse the
 * exact same tool wrappers. `fsTools`/`pythonTool` are conversation-scoped,
 * so they are created here from `conversationId`. The tools resolve their
 * `ToolContext` at call time from the SDK's `experimental_context` (or the
 * module-level `agentConversationId` fallback), so this function does not
 * take a context argument.
 */
export function createBrowserToolSet(
  conversationId: string | null,
): Record<string, ToolSet[string]> {
  const fsTools = createFsTools(conversationId);
  const pythonTool = createPythonTool(conversationId);
  return {
    snapshot: toSDKTool(snapshotTool, "snapshot"),
    readPage: toSDKTool(readPageTool, "readPage"),
    screenshot: toSDKTool(screenshotTool, "screenshot"),
    listTabs: toSDKTool(listTabsTool, "listTabs"),
    navigate: toSDKTool(navigateTool, "navigate"),
    clickElement: toSDKTool(clickElementTool, "clickElement"),
    typeInElement: toSDKTool(typeInElementTool, "typeInElement"),
    scrollPage: toSDKTool(scrollPageTool, "scrollPage"),
    selectTab: toSDKTool(selectTabTool, "selectTab"),
    closeTabs: toSDKTool(closeTabsTool, "closeTabs"),
    saveMemory: toSDKTool(saveMemoryTool, "saveMemory"),
    updateMemory: toSDKTool(updateMemoryTool, "updateMemory"),
    recallMemory: toSDKTool(recallMemoryTool, "recallMemory"),
    deleteMemory: toSDKTool(deleteMemoryTool, "deleteMemory"),
    executeCode: toSDKTool(executeCodeTool, "executeCode"),
    executeOnPage: toSDKTool(executeOnPageTool, "executeOnPage"),
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
        return pinnedConversationId
          ? getOrCreateTabHandle(pinnedConversationId, Number(tabId))
          : `t${Number(tabId)}`;
      },
      resolveHandle: (handle) => {
        return pinnedConversationId
          ? resolveTabHandle(pinnedConversationId, handle)
          : undefined;
      },
      isAgentOwnedTab: async (tabId) => {
        if (!pinnedConversationId) return false;
        const conv = await chatDb.getConversation(pinnedConversationId);
        return !!conv?.ownedTabIds.includes(Number(tabId));
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
        //    windows. Probe in order and take the first live tab.
        for (const tabId of conv.ownedTabIds ?? []) {
          try {
            const tab = await chrome.tabs.get(tabId);
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
    const tabId = resolveTabHandle(cid, handle);
    if (tabId == null) return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      return { tabId, tab };
    } catch {
      return null;
    }
  };

  const needsApproval =
    approvalRequired && toolKey === "closeTabs"
      ? async (input: unknown) => {
          const cid = agentConversationId;
          if (!cid) return true;
          const typed = input as
            | { target: "group" }
            | { target: "tabs"; handles?: string[] };
          let resolved:
            | { target: "group" }
            | { target: "tabs"; tabIds: number[] };
          if (typed?.target === "tabs") {
            const tabIds = (typed.handles ?? [])
              .map((h) => resolveTabHandle(cid, h))
              .filter((id): id is number => id != null);
            resolved = { target: "tabs", tabIds };
          } else {
            resolved = { target: "group" };
          }
          return !(await shouldAutoApproveCloseTabs(cid, resolved));
        }
      : approvalRequired && isTabTool
        ? async (input: unknown) => {
            // The AI SDK calls `needsApproval(input, options)` — `input` is the
            // first positional arg (the tool's parsed input), NOT `{ input }`.
            // Destructuring `{ input }` here (the onInputAvailable shape) read
            // `input.input` (undefined), so the tab handle never resolved and
            // approval was ALWAYS required — the allowlist was never consulted,
            // so "Always allow on <site>" never took effect for later calls.
            // Capture cid once at entry — see resolveTabFromInput's contract.
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
          }
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
      notifyAgentStatus(true, currentSpaceColor, resolved?.tabId ?? null);
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
      const ctx: ToolContext = {
        ...baseCtx,
        toolCallId: options.toolCallId,
        ...(options.abortSignal && { signal: options.abortSignal }),
      };
      const result = await t.execute(input, ctx);
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
      }
      return result;
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

export function resetAgentIndicator() {
  if (agentActive) {
    agentActive = false;
    notifyAgentStatus(false);
  }
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

  const browserTools = createBrowserToolSet(conversationId);

  // The completion-check evaluator runs WITHOUT tools by default.
  //
  // Earlier we handed it a read-only browser/filesystem subset so it
  // could make its own verification calls to ground factual claims.
  // In practice that turned every gate into a multi-step agentic loop
  // (`generateText` + `stepCountIs`, plus an occasional second-stage
  // commit), which dominated end-of-turn latency. The tool-call trace
  // already includes the captured output of every tool the executor
  // ran this turn, so the evaluator can ground the vast majority of
  // claims from context alone. Dropping tools routes the evaluator
  // down its single-shot `generateObject` path (one round-trip) and
  // cuts the perceived "Refining answer" delay dramatically.
  //
  // The evaluator still SUPPORTS tools (see completion-check/evaluator.ts);
  // we simply don't wire any here. To re-enable grounded verification,
  // pass a read-only tool subset as `evaluatorTools` in
  // `buildCompletionCheckInput` below.

  const mcpTools = getMcpRegistry().toSDKTools();

  const mcpToolsList = getMcpRegistry().getAllTools();
  const mcpStates = getMcpRegistry().getStates();
  let instructions = SYSTEM_PROMPT;

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
- **evidenceGrounding**: a factual claim is not supported by tool observations from this turn.
- **noPrematureHandoff**: the response punts work back to the user that was within scope.
- **surfaceAccuracy**: the page state described in the response disagrees with what a verification call observed.

To minimize wasted rejection rounds: before producing a final response, re-read the original request, verify each factual claim was actually observed via a tool call this turn, and confirm your todo list is fully closed out.`;

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
  // ownedTabIds and tab URLs change mid-conversation (navigate adds a tab,
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

  // Apply global enabled flag + per-space allow/deny override
  const availableSkills = skillsState.skills.filter((skill) => {
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
    const cfg = thinkingConfig.config;
    if (cfg.type === "budget") {
      if (provider.id === "anthropic") {
        providerOptions = {
          anthropic: { thinking: { type: "adaptive", display: "summarized" } },
        };
      } else if (provider.id === "google") {
        providerOptions = {
          google: { thinkingConfig: { thinkingBudget: cfg.tokens } },
        };
      }
    } else if (cfg.type === "effort") {
      if (provider.id === "anthropic") {
        providerOptions = {
          anthropic: {
            thinking: { type: "adaptive", display: "summarized" },
            effort: cfg.level,
          },
        };
      } else if (provider.id === "openai") {
        providerOptions = { openai: { reasoning: { effort: cfg.level } } };
      }
    }
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
  });

  const tools = (() => {
    const base = {
      ...parentTools,
      delegate: toSDKTool(delegateTool, "delegate"),
    };
    if (!headless) return base;
    // Headless (scheduled) run: never spawn subagents. When not
    // auto-approving, also drop approval-gated tools (no human to approve).
    const HEADLESS_DROP = new Set<string>(["delegate"]);
    if (!headless.autoApprove) {
      for (const k of [
        "closeTabs",
        "executeOnPage",
        "executePython",
        "updateMemory",
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

  /**
   * Build the dynamic "## Tabs in this conversation" block plus an
   * awareness-only "## Other open tabs" block from live state. Re-reads
   * ownedTabIds from chatDb and queries chrome.tabs each call so the
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
    const ownedTabIds = liveConv?.ownedTabIds ?? [];
    const entries = await buildTabLegendEntries({
      conversationId: cid,
      ownedTabIds,
      getTab: async (tabId) => {
        const tab = await chrome.tabs.get(Number(tabId));
        return { url: tab.url, title: tab.title };
      },
      getOrCreateHandle: (c, tabId) => getOrCreateTabHandle(c, Number(tabId)),
      activeTabId: getTargetTabId(),
    });
    const ownedBlock = renderTabLegend(entries);

    // Awareness block: enumerate user's other open tabs in the current
    // window. Reuses the driver's listTabs (already filters internal
    // URLs and scopes to current window). Errors here must not break
    // the legend — fall back to the owned-only block.
    let awarenessBlock = "";
    try {
      const openTabs = await extensionDriver.listTabs();
      const { entries: awarenessEntries, truncated } =
        buildOpenTabsAwarenessEntries({
          conversationId: cid,
          ownedTabIds,
          openTabs: openTabs.map((t) => ({
            id: t.id,
            url: t.url,
            title: t.title,
            active: !!t.active,
          })),
          getOrCreateHandle: (c, tabId) =>
            getOrCreateTabHandle(c, Number(tabId)),
        });
      awarenessBlock = renderOpenTabsAwareness(awarenessEntries, truncated);
    } catch {
      // No window / chrome.tabs unavailable; skip awareness block.
    }

    return [ownedBlock, awarenessBlock].filter(Boolean).join("\n\n");
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
      const baseInstructions = callArgs.instructions ?? "";
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
        // Intentionally no `evaluatorTools`: the evaluator runs as a
        // single-shot `generateObject` against the conversation context
        // and tool-call trace. See the comment at the
        // `evaluatorReadOnlyTools` removal above for the latency
        // rationale and how to re-enable grounded verification.
      };
    },
    onCompletionCheckApproved: (cid, now) => {
      void persistCompletionMarker(cid, "approved", now);
    },
  });
}
