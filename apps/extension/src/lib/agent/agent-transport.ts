import { getSkillsRegistry } from "@/lib/skills/registry";
import type { ModelDefinition } from "@/registry/providers/types";
import type {
  ChatTransport,
  LanguageModel,
  ToolLoopAgentSettings,
  ToolSet,
} from "ai";
import { ToolLoopAgent, tool } from "ai";
import { z } from "zod";
import { chatDb } from "../chat-db";
import { getMcpRegistry } from "../mcp";
import { sendMcpMessage } from "../mcp/messages";
import { memoryDb } from "../memory-db";
import type { AgentUIMessage, Settings } from "../types";
import { shouldCompact } from "./compaction";
import { CompactingChatTransport } from "./compacting-transport";
import { ExtensionDriver } from "./driver/extension-driver";
import type { ToolContext } from "./driver";
import {
  clearHandles,
  getOrCreateHandle as getOrCreateTabHandle,
  resolveHandle as resolveTabHandle,
} from "./tab-handles";
import {
  clickElementTool,
  createSkillTool,
  deleteMemoryTool,
  executeCodeTool,
  executeOnPageTool,
  extractTool,
  installSkillTool,
  listTabsTool,
  navigateTool,
  readOpfsFileTool,
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
} from "./tools";
import { createFsTools } from "./tools/fs";
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

import { getActiveUserTab, getTargetTabId, setTargetTabId } from "./active-tab";

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

export function notifyAgentStatus(working: boolean, color?: string | null) {
  indicatorQueue = indicatorQueue.then(async () => {
    try {
      const tab = await getActiveUserTab();
      if (!tab.id) return;
      if (working) {
        await injectIndicator(tab.id, color);
      } else {
        await removeIndicator(tab.id);
      }
      chrome.runtime
        .sendMessage({
          type: working ? "AGENT_TAB_WORKING" : "AGENT_TAB_IDLE",
          tabId: tab.id,
          color,
        })
        .catch(() => {});
    } catch {
      // no active tab
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

let agentConversationId: string | null = null;
// Tab id of the panel/popover that initiated this agent run. Used as the
// implicit host tab to bind to a fresh conversation on the first tab tool
// call (so the agent has a target without the user manually clicking
// "Work on this tab").
let agentHostTabId: number | null = null;

let lastTotalTokens = 0;
let currentModelDef: ModelDefinition | undefined;

/**
 * The LanguageModel instance for the currently-active agent session. Tools
 * that need to make their own LLM calls (e.g. `extract`) read this instead of
 * wiring the model through tool context. Set in `createAgentTransport`.
 */
let currentAgentModel: LanguageModel | null = null;

export function getCurrentAgentModel(): LanguageModel | null {
  return currentAgentModel;
}

export function setCurrentAgentModel(model: LanguageModel | null): void {
  currentAgentModel = model;
}

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

export function setAgentContext(
  conversationId: string | null,
  hostTabId: number | null = null,
) {
  if (agentConversationId && agentConversationId !== conversationId) {
    clearHandles(agentConversationId);
  }
  agentConversationId = conversationId;
  agentHostTabId = hostTabId;
}

export function getAgentContext(): {
  conversationId: string | null;
  hostTabId: number | null;
} {
  return {
    conversationId: agentConversationId,
    hostTabId: agentHostTabId,
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

/**
 * Singleton driver instance for the production extension. Tools receive this
 * via the `ToolContext` threaded through `experimental_context`. Stateless;
 * the driver itself is just a thin facade over `cdp-session`/`active-tab`.
 */
const extensionDriver = new ExtensionDriver();

/**
 * Build the `ToolContext` for an agent session. The context exposes the
 * driver plus session-level orchestration callbacks (tab handle map,
 * conversation-tab binding) that only make sense in the extension. The bench
 * harness builds its own minimal context with `session` left undefined.
 *
 * Session helpers read `getAgentContext().conversationId` lazily at call
 * time so the same context object stays valid across conversation switches.
 */
function buildExtensionToolContext(): ToolContext {
  return {
    driver: extensionDriver,
    session: {
      get conversationId() {
        return getAgentContext().conversationId;
      },
      bindTabsToConversation: async (tabIds) => {
        const cid = getAgentContext().conversationId;
        if (!cid) return;
        try {
          await chrome.runtime.sendMessage({
            type: "BIND_TABS_TO_CONVERSATION",
            conversationId: cid,
            tabIds: tabIds.map((t) => Number(t)),
          });
        } catch {
          // Background asleep; rebuilds on next startup.
        }
      },
      bindActiveTabToConversation: async (tabId) => {
        const cid = getAgentContext().conversationId;
        if (!cid) return;
        try {
          await chrome.runtime.sendMessage({
            type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
            conversationId: cid,
            tabId: Number(tabId),
          });
        } catch {
          // Background asleep; rebuilds on next startup.
        }
      },
      getOrCreateHandle: (tabId) => {
        const cid = getAgentContext().conversationId;
        return cid
          ? getOrCreateTabHandle(cid, Number(tabId))
          : `t${Number(tabId)}`;
      },
      resolveHandle: (handle) => {
        const cid = getAgentContext().conversationId;
        return cid ? resolveTabHandle(cid, handle) : undefined;
      },
      isAgentOwnedTab: async (tabId) => {
        const cid = getAgentContext().conversationId;
        if (!cid) return false;
        const conv = await chatDb.getConversation(cid);
        return !!conv?.ownedTabIds.includes(Number(tabId));
      },
      hasOwnedTabGroup: async () => {
        const cid = getAgentContext().conversationId;
        if (!cid) return false;
        const conv = await chatDb.getConversation(cid);
        return conv?.ownedGroupId != null;
      },
      getTodos: async () => {
        const cid = getAgentContext().conversationId;
        if (!cid) return [];
        const conv = await chatDb.getConversation(cid);
        return conv?.todos || [];
      },
      setTodos: async (todos) => {
        const cid = getAgentContext().conversationId;
        if (!cid) return;
        await chatDb.updateConversation(cid, {
          todos,
          updatedAt: Date.now(),
        });
      },
    },
  };
}

function toSDKTool<TInput, TOutput>(
  t: BrowserTool<TInput, TOutput>,
  toolKey: string,
): ToolSet[string] {
  const isTabTool = TAB_INTERACTING_TOOLS.has(toolKey);
  const isImageTool = IMAGE_TOOLS.has(toolKey);

  const approvalRequired = t.approval?.required ?? false;

  const needsApproval =
    approvalRequired && isTabTool
      ? async () => {
          try {
            const tab = await getActiveUserTab();
            if (tab.url) {
              const origin = new URL(tab.url).origin;
              const allowlist = await getToolSiteAllowlist();
              const allowed = allowlist[toolKey] ?? [];
              if (allowed.includes(origin)) return false;
            }
          } catch {}
          return true;
        }
      : approvalRequired;

  const execute = async (
    input: TInput,
    options: { toolCallId: string; experimental_context?: unknown },
  ) => {
    if (isTabTool) {
      agentActive = true;
      notifyAgentStatus(true, currentSpaceColor);
    }
    const pinnedTabId = capturedTabIds.get(options.toolCallId);
    const previousTargetTabId = getTargetTabId();
    capturedToolOrigins.delete(options.toolCallId);
    if (pinnedTabId != null) {
      capturedTabIds.delete(options.toolCallId);
      setTargetTabId(pinnedTabId);
    }
    if (isTabTool) {
      // Implicit host-tab binding: on the first tab-interacting tool call
      // for a conversation that hasn't owned any tabs yet, bind the panel's
      // host tab so the agent has a working target. Skipped when the host
      // tab is unknown, an extension/chrome page, or already in the group.
      if (
        agentConversationId &&
        agentHostTabId != null &&
        getTargetTabId() == null
      ) {
        try {
          const conv = await chatDb.getConversation(agentConversationId);
          if (conv && conv.ownedTabIds.length === 0) {
            const hostTab = await chrome.tabs
              .get(agentHostTabId)
              .catch(() => null);
            const hostUrl = hostTab?.url ?? "";
            const isInternal =
              hostUrl.startsWith("chrome://") ||
              hostUrl.startsWith("chrome-extension://") ||
              hostUrl.startsWith("devtools://");
            if (hostTab && !isInternal && !hostTab.pinned) {
              await chrome.runtime
                .sendMessage({
                  type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
                  conversationId: agentConversationId,
                  tabId: agentHostTabId,
                })
                .catch(() => {});
              setTargetTabId(agentHostTabId);
            }
          }
        } catch {
          // Best-effort; the agent's own bootstrap fallback (getActiveUserTab)
          // will pick up where this leaves off.
        }
      }
      try {
        const tab = await getActiveUserTab();
        if (tab.id && tab.title) {
          toolTabInfoStore.set(options.toolCallId, {
            tabId: tab.id,
            title: tab.title,
            favIconUrl: tab.favIconUrl,
          });
        }
      } catch {}
    }
    try {
      // Threaded ToolContext from the SDK's experimental_context channel.
      // Tools that haven't migrated still receive (input) — TS allows
      // dropping the second param. Once all tools read ctx the cast can
      // tighten to a non-optional check.
      const ctx = (options.experimental_context as ToolContext | undefined)
        ?? buildExtensionToolContext();
      const result = await t.execute(input, ctx);
      toolResultStore.set(options.toolCallId, result);
      if (isTabTool) {
        try {
          const tab = await getActiveUserTab();
          if (tab.id && tab.title) {
            toolTabInfoStore.set(options.toolCallId, {
              tabId: tab.id,
              title: tab.title,
              favIconUrl: tab.favIconUrl,
            });
          }
        } catch {}
      }
      return result;
    } catch (err) {
      const errResult = {
        error: err instanceof Error ? err.message : String(err),
      };
      toolResultStore.set(options.toolCallId, errResult);
      return errResult as TOutput;
    } finally {
      if (pinnedTabId != null) {
        setTargetTabId(previousTargetTabId);
      }
    }
  };

  const onInputAvailable =
    approvalRequired && isTabTool
      ? async (opts: { toolCallId: string }) => {
          try {
            const tab = await getActiveUserTab();
            if (tab.id) capturedTabIds.set(opts.toolCallId, tab.id);
            if (tab.url) {
              capturedToolOrigins.set(opts.toolCallId, new URL(tab.url).origin);
            }
            if (tab.id && tab.title) {
              toolTabInfoStore.set(opts.toolCallId, {
                tabId: tab.id,
                title: tab.title,
                favIconUrl: tab.favIconUrl,
              });
            }
          } catch {}
        }
      : undefined;

  const toModelOutput = isImageTool
    ? ({ output }: { output: TOutput }) => {
        const { imageDataUrl } = output as { imageDataUrl: string };
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
    outputSchema: t.outputSchema,
    strict: true,
    execute,
    needsApproval,
  } as ToolSet[string];
}

export function resetAgentIndicator() {
  if (agentActive) {
    agentActive = false;
    notifyAgentStatus(false);
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
): Promise<ChatTransport<AgentUIMessage> | null> {
  if (!agentModel) return null;

  const { providers } = await import("@/registry/providers");
  const provider = providers.find((p) =>
    p.models.some((m) => m.id === agentModel),
  );
  if (!provider) return null;

  const config = settings.providerConfigs[provider.id] ?? {};
  const requiredFields = provider.configSchema?.filter((f) => f.required) ?? [];
  if (!requiredFields.every((f) => !!config[f.key])) return null;

  const model = provider.createLanguageModel(config, agentModel);
  setCurrentAgentModel(model);

  const fsTools = createFsTools(conversationId);

  const browserTools: Record<string, ToolSet[string]> = {
    snapshot: toSDKTool(snapshotTool, "snapshot"),
    readPage: toSDKTool(readPageTool, "readPage"),
    screenshot: toSDKTool(screenshotTool, "screenshot"),
    listTabs: toSDKTool(listTabsTool, "listTabs"),
    navigate: toSDKTool(navigateTool, "navigate"),
    clickElement: toSDKTool(clickElementTool, "clickElement"),
    typeInElement: toSDKTool(typeInElementTool, "typeInElement"),
    scrollPage: toSDKTool(scrollPageTool, "scrollPage"),
    selectTab: toSDKTool(selectTabTool, "selectTab"),
    saveMemory: toSDKTool(saveMemoryTool, "saveMemory"),
    updateMemory: toSDKTool(updateMemoryTool, "updateMemory"),
    recallMemory: toSDKTool(recallMemoryTool, "recallMemory"),
    deleteMemory: toSDKTool(deleteMemoryTool, "deleteMemory"),
    executeCode: toSDKTool(executeCodeTool, "executeCode"),
    executeOnPage: toSDKTool(executeOnPageTool, "executeOnPage"),
    extract: toSDKTool(extractTool, "extract"),
    todoWrite: toSDKTool(todoWriteTool, "todoWrite"),
    skill: toSDKTool(skillTool, "skill"),
    install_skill: toSDKTool(installSkillTool, "install_skill"),
    create_skill: toSDKTool(createSkillTool, "create_skill"),
    read_opfs_file: toSDKTool(readOpfsFileTool, "read_opfs_file"),
    Read: toSDKTool(fsTools.readTool, "Read"),
    Write: toSDKTool(fsTools.writeTool, "Write"),
    Edit: toSDKTool(fsTools.editTool, "Edit"),
    Glob: toSDKTool(fsTools.globTool, "Glob"),
    Grep: toSDKTool(fsTools.grepTool, "Grep"),
    LS: toSDKTool(fsTools.lsTool, "LS"),
  };

  const mcpTools = getMcpRegistry().toSDKTools();

  const mcpToolsList = getMcpRegistry().getAllTools();
  const mcpStates = getMcpRegistry().getStates();
  let instructions = SYSTEM_PROMPT;

  if (spaceId && spaceName) {
    instructions += `\n\nYou are chatting from the space "${spaceName}" (id: ${spaceId}). When saving space-scoped memories, use this spaceId.`;
  }

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

    instructions += `\n\n## Available Skills\n\nYou have access to the following skills. Each skill is knowledge you can load on demand. When a user's request matches a skill's description, call skill({ name }) to load its full instructions into the conversation.\n\n${skillsSection}\n\nTo install a new skill from a URL or GitHub repo, use install_skill({ source }).\nTo read a file bundled with a skill, use read_opfs_file({ path }).\nTo author and install a new skill you've drafted for the user, use create_skill.`;
  }

  const tools = { ...browserTools, ...mcpTools };

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

  // Per-stream "needs mid-stream compaction" signal. Set by `onStepFinish`
  // when token usage crosses the threshold; read by `stopWhen` to break
  // the loop after the current step completes (matching OpenCode's
  // step-boundary behavior). Cleared at the start of each `sendMessages`
  // by the wrapper transport so a previous turn's signal doesn't leak.
  let needsMidStreamCompaction = false;

  const agent = new ToolLoopAgent({
    model,
    tools,
    instructions,
    ...(providerOptions && { providerOptions }),
    // Per-call ToolContext threaded through `experimental_context` →
    // `ToolExecutionOptions.experimental_context` → our `toSDKTool` wrapper.
    // Session helpers read live agent state via getters so the same context
    // object stays valid across conversation switches.
    experimental_context: buildExtensionToolContext(),
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
    },
    stopWhen: () => needsMidStreamCompaction,
  });

  return new CompactingChatTransport({
    agent,
    onSendStart: () => {
      needsMidStreamCompaction = false;
    },
  });
}
