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
import type {
  AgentUIMessage,
  ApprovedPlan,
  ConversationMode,
  Settings,
} from "../types";
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
  listHandles as listTabHandles,
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
import { buildWorkspaceFilesBlock } from "./workspace-legend";
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
  createArtifactTool,
  updateArtifactTool,
  deleteArtifactTool,
  listArtifactsTool,
  readArtifactDiagnosticsTool,
  proposePlanTool,
} from "./tools";
import { createDelegateTool } from "./tools/delegate";
import { createFsTools, isAnySpacePath } from "./tools/fs";
import { createPythonTool } from "./tools/execute-python";
import { setTaskTitleTool } from "./tools/set-task-title";
import { staticReadCheck } from "./execute-on-page-static-check";
import {
  planExtensionForCall,
  extendPlanWithSite,
  flipPlanNetwork,
} from "./plan-store";
import type { PlanExtensionData, SerializedUIPart } from "./message-types";
import type { BrowserTool } from "./types";

import { SYSTEM_PROMPT, CUA_DELEGATION_PROMPT } from "./system-prompt";
import { buildEditingArtifactBlock } from "./artifact-edit-context";

/**
 * When true, the background site-skill curator logs each pipeline stage to the
 * service-worker console with a `[curator]` prefix (gate passed → candidate
 * counts → enqueue → drain → per-job). This pipeline runs fire-and-forget and
 * is otherwise silent on the happy path. Off in production; flip back to true
 * locally if you need to validate the pipeline end-to-end.
 */
const DEBUG_CURATOR = false;

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
- The index below shows [type] [scope] title: description for each memory
- Call recallMemory with the title to read the full content. The result is always a \`matches: [...]\` array — usually one entry, but may contain two when the same title exists in both \`user\` (global) and \`space\` scopes
- Call saveMemory to create a new memory (title, description, type, content required; scope required when a space is active)
- Call updateMemory to modify an existing memory (requires user approval; scope is preserved across updates)
- Call deleteMemory to remove a memory

You never pass a spaceId. The active space is determined by the session, not by you. You only choose *whether* a memory is scoped to the user (global) or to the active space.

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

### Scoping

A memory is either **global** (visible everywhere) or **space-scoped** (visible only inside the space it was saved in). Globals are *always* visible from inside any space — a space-scoped memory does not hide or replace a global of the same title; recallMemory will return both.

\`saveMemory\` accepts a \`scope\` field with two values:

- \`scope: "user"\` — global memory. Use for facts about the human themself: identity, name, role, company, expertise, universal preferences, behavior corrections that apply across every project.
- \`scope: "space"\` — scoped to the active space. Use for facts about this space's project: repos, tools, dashboards, references, project-specific preferences and workflows.

**Inside a space, \`scope\` is required** — you must pick one. Outside any space, \`scope\` may be omitted; only \`"user"\` is meaningful (the tool will error on \`"space"\`).

Test: "Is this fact still true and useful in a completely unrelated space?"
- Yes → \`scope: "user"\`
- No → \`scope: "space"\`

Examples (assume the active space is "Development"):
- "OpenBrowse's GitHub repo is openbrowse-ai/openbrowse" → \`scope: "space"\` (about the project, not about the user; useless in a different space).
- "I'm a frontend engineer at Acme" → \`scope: "user"\` (about the human, applies everywhere).
- "On GitHub, always go to Files Changed first" → \`scope: "user"\` (universal site behavior).
- "In this space, group tabs by repo" → \`scope: "space"\` (project-specific preference).
- "The on-call rotation page is at acme.pagerduty.com/schedules/123" while in the Ops space → \`scope: "space"\` (project reference).

### Disambiguating updates and deletes

When the same title exists in both \`user\` and \`space\` scope, \`updateMemory\` and \`deleteMemory\` will refuse to act and return a \`matches\` array showing both. You then call the tool again with \`scope: "user"\` or \`scope: "space"\` to specify which one to operate on. When only one match exists (the common case), omit \`scope\` and the tool just works.

### What NOT to save
- Current page content or tab URLs (ephemeral)
- Anything you can see in the current tabs
- One-off task details that won't matter next session

### When to delete memories
- User says "forget X" or "stop doing X" (if it contradicts a saved feedback)
- A memory is clearly outdated based on conversation context
`;

import { getTargetTabId, registerCidResolver } from "./active-tab";
import { notifyAgentStatus } from "./agent-indicator";
import { startCapture } from "./cdp-capture";
import { releaseAll as releaseAllSessions } from "./cdp-session";

export { notifyAgentStatus };

/**
 * Per-conversation glow tint cache for the working-overlay. Replaces the
 * pre-refactor module-scope `currentSpaceColor` singleton, which clobbered
 * across parallel runs (different spaces / different conversations / parent+
 * subagent peers). Populated eagerly when known (renderer or SW resolves the
 * conversation's space and stashes the color via `setAgentColor`), or lazily
 * resolved on first tool call via `ensureAgentColor`. Cleared on cid context
 * change is intentionally NOT done — the cache is small and a stale entry is
 * harmless (it just paints last-known color until the next resolve).
 */
const agentColorByCid = new Map<string, string | null>();

export function setAgentColor(
  conversationId: string,
  color: string | null,
): void {
  agentColorByCid.set(conversationId, color);
}

export function getAgentColor(conversationId: string | null): string | null {
  if (conversationId == null) return null;
  return agentColorByCid.get(conversationId) ?? null;
}

/**
 * Per-conversation Chrome window cache for the agent's tab queries.
 *
 * The SW realm builds one `ToolContext` per agent run via
 * `buildExtensionToolContext`. `session.targetWindowId` on that context
 * is read by every window-aware path (system-prompt awareness block,
 * `listTabs`, `bindTabByHandle`, navigate's no-handle path). Resolving
 * it via async `chrome.windows.getCurrent()` from the SW realm would
 * return the focused window — wrong for any parallel-window scenario.
 *
 * Cache: populated eagerly at `AGENT_RUN_START` (see
 * `agent-host/bootstrap.ts`) and at renderer-side `useAgentChat`
 * mount (renderer realm convenience); resolved lazily via
 * `ensureAgentWindow` on first tool call if unset. The session getter
 * reads from this map.
 */
const agentWindowByCid = new Map<string, number | null>();

/**
 * Cache a window id for `conversationId`. We deliberately accept the
 * `windowId: number | null` API shape (callers like
 * `agent-host/bootstrap.ts` pass `resolveConversationWindowId(cid) ?? null`)
 * but DO NOT store null/undefined — `ensureAgentWindow` would otherwise
 * treat the cached null as a terminal miss and never re-run the resolver
 * after a transient lookup failure (e.g. the conversation's window
 * binding isn't ready at SW boot but becomes available a moment later).
 *
 * Null/undefined writes are equivalent to "leave the cache untouched",
 * preserving any prior value. If a real id has never been cached, future
 * reads will fall back to the lazy resolver.
 */
export function setAgentWindow(
  conversationId: string,
  windowId: number | null,
): void {
  if (windowId == null) return;
  agentWindowByCid.set(conversationId, windowId);
}

export function getAgentWindow(
  conversationId: string | null,
): number | undefined {
  if (conversationId == null) return undefined;
  const v = agentWindowByCid.get(conversationId);
  return v == null ? undefined : v;
}

/**
 * Lazy resolver for the conversation's working window. Returns the
 * cached value if known; otherwise delegates to
 * `resolveConversationWindowId` (owned tab → originWindowId → space
 * window → undefined) and caches the result. Undefined results are
 * NOT cached so a transient lookup failure recovers on the next call.
 */
async function ensureAgentWindow(
  conversationId: string | null,
): Promise<number | undefined> {
  if (conversationId == null) return undefined;
  const cached = agentWindowByCid.get(conversationId);
  if (cached !== undefined) return cached ?? undefined;
  try {
    // Variable-indirection import — opaque to tsc's static module-graph
    // walk so `packages/bench` doesn't transitively typecheck
    // `conversation-window` (which uses `@/*` aliases + chrome globals
    // that bench's tsconfig doesn't provide). Bundler resolution at
    // runtime is unaffected. See the matching comment in
    // `active-tab.ts`.
    const modulePath: string = "./conversation-window";
    const mod = (await import(modulePath)) as {
      resolveConversationWindowId: (
        cid: string,
      ) => Promise<number | undefined>;
    };
    const resolved = await mod.resolveConversationWindowId(conversationId);
    if (resolved !== undefined) {
      agentWindowByCid.set(conversationId, resolved);
    }
    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * Lazy resolver: looks up the conversation's space color from storage, caches
 * it, and returns it. Cheap on cache hit. Async + storage-bound on miss; the
 * tool wrapper awaits this so the very first tool call gets the right tint.
 */
async function ensureAgentColor(
  conversationId: string | null,
): Promise<string | null> {
  if (conversationId == null) return null;
  const cached = agentColorByCid.get(conversationId);
  if (cached !== undefined) return cached;
  try {
    const { chatDb } = await import("@/lib/chat-db");
    const conv = await chatDb.getConversation(conversationId);
    const spaceId = conv?.spaceId ?? null;
    if (spaceId == null) {
      agentColorByCid.set(conversationId, null);
      return null;
    }
    const { storage } = await import("@/lib/storage");
    const spaces = await storage.getSpaces();
    const color = spaces.find((s) => s.id === spaceId)?.colors?.[0] ?? null;
    agentColorByCid.set(conversationId, color);
    return color;
  } catch {
    // Lookup failed — cache null so we don't hammer storage on every tool
    // call. The next eager `setAgentColor` (e.g. on a fresh AGENT_RUN_START)
    // will overwrite this.
    agentColorByCid.set(conversationId, null);
    return null;
  }
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
  "read_network_requests",
  "read_console_messages",
]);

/**
 * Pure policy core for the Plan-mode in-plan check. Extracted from the
 * per-tool closure inside `createAgent` so a regression test can drive
 * the cid-pinning contract end-to-end without a live agent: the test
 * supplies a `resolveTab` stub that asserts the cid it sees is the one
 * the dispatcher pinned at entry, not whatever the module global has
 * mutated to mid-await.
 *
 * Production callers wire `resolveTab` to `resolveTabFromInput` (which
 * itself reads `agentConversationId` only through its `cid` parameter).
 *
 * Returns `true` when the call is "in plan" — the dispatcher should
 * skip approval. Falls back to `false` (off-plan, prompt) when the tab
 * can't be resolved or its URL doesn't parse, matching the FAIL CLOSED
 * default the original closure used.
 */
export async function isInPlanCore(
  toolKey: string,
  input: unknown,
  plan: ApprovedPlan,
  cid: string | null,
  resolveTab: (
    cid: string | null,
    input: unknown,
  ) => Promise<{ tab: { url?: string } } | null>,
): Promise<boolean> {
  if (toolKey === "proposePlan") return true;

  if (toolKey === "executePython") {
    const wantsNetwork =
      (input as { allow_network?: unknown })?.allow_network === true;
    if (wantsNetwork) return plan.allowNetwork;
    return true;
  }

  if (!TAB_INTERACTING_TOOLS.has(toolKey)) return true;

  const resolved = await resolveTab(cid, input);
  if (!resolved?.tab.url) return false;
  try {
    const origin = new URL(resolved.tab.url).origin;
    return plan.sites.includes(origin);
  } catch {
    return false;
  }
}

let agentActive = false;

let agentConversationId: string | null = null;

// Register a cid lookup with active-tab.ts so its sync getters (e.g.
// `getTargetTabId()` with no arg, called by the driver) read the
// current run's cid. Avoids a static import cycle (active-tab.ts has
// no static import of this module).
registerCidResolver(() => agentConversationId);

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
 * Persist a synthetic user-role marker that surfaces a Plan auto-extension
 * inline in the conversation stream. The chat UI subscribes to chatDb's
 * message stream so this renders without any stream-controller plumbing.
 *
 * Failure here is non-fatal — the actual plan extension (in IDB via
 * `plan-store`) has already succeeded by the time we get here; the marker
 * is purely a UI signal. We log and move on so a write hiccup never blocks
 * the tool call that triggered the extension.
 *
 * The part is stripped before reaching the LLM (see `rewriteForLLM` in
 * `compacting-transport.ts`); the model never sees it.
 */
async function savePlanExtensionMarker(
  conversationId: string,
  data: PlanExtensionData,
): Promise<void> {
  try {
    const part: SerializedUIPart = { type: "data-plan-extension", data };
    await chatDb.saveMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: "user",
      content: "",
      parts: [part],
      createdAt: Date.now(),
    });
  } catch (err) {
    // Non-fatal — the extension persisted; the marker is purely UI.
    console.warn("[plan] failed to save extension marker:", err);
  }
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
export function createBrowserToolSet(
  /**
   * Pinned conversation id for every tool's runtime closure. Threaded
   * into `toSDKTool` so each tool wrapper reads a stable cid rather than
   * the module-scope `agentConversationId` global, which the SW agent
   * host clobbers on every concurrent `setAgentContext` call.
   *
   * `null` for the curator's replay-only toolset and legacy callers.
   */
  pinnedConversationId: string | null = null,
): Record<string, ToolSet[string]> {
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
  const cid = pinnedConversationId;
  return {
    snapshot: toSDKTool(snapshotTool, "snapshot", cid),
    readPage: toSDKTool(readPageTool, "readPage", cid),
    screenshot: toSDKTool(screenshotTool, "screenshot", cid),
    listTabs: toSDKTool(listTabsTool, "listTabs", cid),
    navigate: toSDKTool(navigateTool, "navigate", cid),
    clickElement: toSDKTool(clickElementTool, "clickElement", cid),
    typeInElement: toSDKTool(typeInElementTool, "typeInElement", cid),
    pressKey: toSDKTool(pressKeyTool, "pressKey", cid),
    scrollPage: toSDKTool(scrollPageTool, "scrollPage", cid),
    selectTab: toSDKTool(selectTabTool, "selectTab", cid),
    closeTabs: toSDKTool(closeTabsTool, "closeTabs", cid),
    saveMemory: toSDKTool(saveMemoryTool, "saveMemory", cid),
    updateMemory: toSDKTool(updateMemoryTool, "updateMemory", cid),
    recallMemory: toSDKTool(recallMemoryTool, "recallMemory", cid),
    deleteMemory: toSDKTool(deleteMemoryTool, "deleteMemory", cid),
    executeCode: toSDKTool(executeCodeTool, "executeCode", cid),
    executeOnPage: toSDKTool(executeOnPageTool, "executeOnPage", cid),
    read_network_requests: toSDKTool(readNetworkRequestsTool, "read_network_requests", cid),
    read_console_messages: toSDKTool(readConsoleMessagesTool, "read_console_messages", cid),
    patch_site_skill: toSDKTool(guardedPatchSiteSkill, "patch_site_skill", cid),
    delete_site_skill: toSDKTool(deleteSiteSkillTool, "delete_site_skill", cid),
    executePython: toSDKTool(pythonTool, "executePython", cid),
    extract: toSDKTool(extractTool, "extract", cid),
    todoWrite: toSDKTool(todoWriteTool, "todoWrite", cid),
    proposePlan: toSDKTool(proposePlanTool, "proposePlan", cid),
    skill: toSDKTool(skillTool, "skill", cid),
    install_skill: toSDKTool(installSkillTool, "install_skill", cid),
    create_skill: toSDKTool(createSkillTool, "create_skill", cid),
    create_scheduled_task: toSDKTool(
      createScheduledTaskTool,
      "create_scheduled_task",
      cid,
    ),
    list_scheduled_tasks: toSDKTool(
      listScheduledTasksTool,
      "list_scheduled_tasks",
      cid,
    ),
    update_scheduled_task: toSDKTool(
      updateScheduledTaskTool,
      "update_scheduled_task",
      cid,
    ),
    Read: toSDKTool(fsTools.readTool, "Read", cid),
    Write: toSDKTool(fsTools.writeTool, "Write", cid),
    Edit: toSDKTool(fsTools.editTool, "Edit", cid),
    Glob: toSDKTool(fsTools.globTool, "Glob", cid),
    Grep: toSDKTool(fsTools.grepTool, "Grep", cid),
    LS: toSDKTool(fsTools.lsTool, "LS", cid),
    Delete: toSDKTool(fsTools.deleteTool, "Delete", cid),
    create_artifact: toSDKTool(createArtifactTool, "create_artifact", cid),
    update_artifact: toSDKTool(updateArtifactTool, "update_artifact", cid),
    delete_artifact: toSDKTool(deleteArtifactTool, "delete_artifact", cid),
    list_artifacts: toSDKTool(listArtifactsTool, "list_artifacts", cid),
    read_artifact_diagnostics: toSDKTool(
      readArtifactDiagnosticsTool,
      "read_artifact_diagnostics",
      cid,
    ),
  };
}

export function buildExtensionToolContext(
  pinnedConversationId: string | null,
  pinnedSpaceId: string | null = null,
): ToolContext {
  // Stamp the conversation's resolved working window onto the session
  // so synchronous reads (system-prompt awareness, listTabs tool,
  // bindTabByHandle, navigate's no-handle path) all agree on which
  // window to query without re-resolving. `getAgentWindow` reads the
  // module-scope cache populated by the SW agent-host bootstrap at
  // RUN_START. When unset (cache miss in tests, or pre-resolve race),
  // we leave `targetWindowId` undefined and callers fall back to
  // `resolveNewTabWindowId` (which itself does the lazy resolve).
  const pinnedWindowId = getAgentWindow(pinnedConversationId);

  return {
    driver: extensionDriver,
    session: {
      conversationId: pinnedConversationId,
      spaceId: pinnedSpaceId,
      ...(pinnedWindowId !== undefined && { targetWindowId: pinnedWindowId }),
      bindTabsToConversation: async (tabIds) => {
        if (!pinnedConversationId) return;
        const { bindTabsRPC } = await import("./tab-binding-rpc");
        await bindTabsRPC(
          pinnedConversationId,
          tabIds.map((t) => Number(t)),
        );
      },
      bindActiveTabToConversation: async (tabId) => {
        if (!pinnedConversationId) return;
        const { bindActiveTabRPC } = await import("./tab-binding-rpc");
        await bindActiveTabRPC(pinnedConversationId, Number(tabId));
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
      listHandles: () => {
        // Used by tab-resolution error messages to inline the legend so
        // the agent can recover from a stale handle without a separate
        // listTabs round-trip. tool-context.ts threads this through;
        // bench's session leaves it undefined and falls back to the
        // no-summary error wording.
        return pinnedConversationId
          ? listTabHandles(pinnedConversationId)
          : [];
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
      getPlan: async () => {
        if (!pinnedConversationId) return undefined;
        const conv = await chatDb.getConversation(pinnedConversationId);
        return conv?.plan;
      },
      setPlan: async (plan) => {
        if (!pinnedConversationId) return;
        await chatDb.updateConversation(pinnedConversationId, {
          plan,
          updatedAt: Date.now(),
        });
      },
      getMode: async () => {
        if (!pinnedConversationId) return "ask";
        const conv = await chatDb.getConversation(pinnedConversationId);
        return conv?.mode ?? "ask";
      },
      resolveNewTabWindowId: async () => {
        // Delegates to the shared resolver so the awareness-block,
        // listTabs, bindTabByHandle, and navigate paths all agree on
        // "which window is this conversation in". See
        // `./conversation-window.ts` for the resolution chain (owned
        // tab → originWindowId → space window → undefined).
        if (!pinnedConversationId) return undefined;
        // Variable-indirection import — see `ensureAgentWindow` above
        // for the rationale (hides this module from bench's tsc walk).
        const modulePath: string = "./conversation-window";
        const mod = (await import(modulePath)) as {
          resolveConversationWindowId: (
            cid: string,
          ) => Promise<number | undefined>;
        };
        return mod.resolveConversationWindowId(pinnedConversationId);
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
  /**
   * Pinned conversation id for this tool's runtime closures. Pre-SW-host
   * this was always read from the module-scope `agentConversationId`
   * global, which the renderer's `setAgentContext` mutated on conversation
   * switch. Under SW-host the same global is now shared across every
   * concurrent run hosted in the worker, so any read of it inside a tool
   * wrapper attributes work to whichever conversation started most
   * recently — wrong for all but the last. Pinning here, at transport
   * construction time, gives every tool wrapper a stable cid that survives
   * other concurrent runs starting in the same SW.
   *
   * `null` is allowed for legacy callers (e.g. tests, the curator's
   * replay-only toolset) that have no conversation context; the wrapper
   * tolerates a null cid at every read site, same as before.
   */
  pinnedConversationId: string | null = null,
): ToolSet[string] {
  const isTabTool = TAB_INTERACTING_TOOLS.has(toolKey);
  const isImageTool = IMAGE_TOOLS.has(toolKey);

  const approvalRequired = t.approval?.required ?? false;

  /**
   * Returns the conversation id to attribute this tool wrapper's
   * runtime work to. Prefers the pinned id captured at transport-
   * construction time. Falls back to the legacy module-scope
   * `agentConversationId` global for callers (tests, ad-hoc usage)
   * that did not pin one. Production SW always pins, so the fallback
   * branch never fires there.
   */
  const getCid = (): string | null =>
    pinnedConversationId ?? agentConversationId;

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
    const cid = getCid();
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

  /**
   * Read the conversation's current approval mode + plan. Used by the
   * mode-aware `needsApproval` wrapper to dispatch on mode. Returns
   * `{ mode: "ask" }` when:
   *   - no conversation is bound (defensive),
   *   - the conversation row has no `mode` field (pre-v17 rows / new
   *     conversations default to Ask, the original pre-modes behavior),
   *   - the chatDb read throws (e.g. IDB unavailable in some test
   *     harnesses, or the conversation row was deleted mid-call). The
   *     fallback preserves Ask-mode semantics — i.e. existing behavior —
   *     rather than failing the approval check entirely.
   *
   * Takes `cid` as a parameter rather than reading `agentConversationId`
   * directly so callers pin a snapshot at entry. Both the auto-extension
   * hook in `execute` and the mode-aware dispatcher in `needsApproval`
   * capture cid before their first await; this keeps mode/plan reads,
   * plan-extension persistence, and downstream tab resolution coherent
   * across awaits even if the user switches conversations mid-call.
   */
  const resolveModeAndPlan = async (
    cid: string | null,
  ): Promise<{
    mode: ConversationMode;
    plan: ApprovedPlan | undefined;
  }> => {
    if (!cid) return { mode: "ask", plan: undefined };
    try {
      const conv = await chatDb.getConversation(cid);
      return {
        mode: conv?.mode ?? "ask",
        plan: conv?.plan,
      };
    } catch (err) {
      // Same fallback the per-turn refresh hook uses below: if the read
      // fails for any reason, default to Ask mode so we err on the side
      // of prompting the user (the safe default) rather than silently
      // skipping approvals under a stale cached mode.
      console.warn(
        "[agent] resolveModeAndPlan failed; falling back to Ask mode",
        err,
      );
      return { mode: "ask", plan: undefined };
    }
  };

  /**
   * Decide whether a tool call falls within an approved plan. Used by
   * Plan mode's `needsApproval` to decide between skip-approval (in-plan)
   * and prompt (off-plan).
   *
   *   - `proposePlan`: always in-plan. (It's gated by Plan-mode dispatch
   *     itself; this branch is only reached when called via isInPlan.)
   *   - `executePython`: in-plan when the call doesn't request network
   *     OR when the plan permits it (`plan.allowNetwork`).
   *   - Tab-targeted tools: resolve target tab's origin against
   *     `plan.sites`. Falls back to "in-plan" when the tab can't be
   *     resolved — same defensive default as `tabToolNeedsApproval`'s
   *     unresolvable case.
   *   - Other tools (todoWrite, recallMemory, etc.): in-plan by default.
   *     They have no origin or network semantics for the plan to gate.
   */
  const isInPlan = (
    toolKeyArg: string,
    input: unknown,
    plan: ApprovedPlan,
    cid: string | null,
  ): Promise<boolean> =>
    // Delegate to the pure policy core (module-level, exported for
    // tests). Wires `resolveTab` to the closure-bound
    // `resolveTabFromInput` so production callers retain the same
    // tabRegistry / chrome.tabs path as before; tests can call
    // `isInPlanCore` directly with a stub resolver to verify the
    // cid-pinning contract.
    isInPlanCore(toolKeyArg, input, plan, cid, resolveTabFromInput);

  const askModeNeedsApproval =
    approvalRequired && toolKey === "executePython"
      ? // Python only needs human approval when it requests outbound network
        // access. Sandboxed runs (no `allow_network`, the default) touch only
        // the conversation's OPFS workspace + read-only /skills — as safe as
        // the always-available fs tools — so they execute without a prompt.
        // The SDK passes the parsed tool input as the first positional arg.
        (input: unknown) =>
          (input as { allow_network?: unknown })?.allow_network === true
      : approvalRequired && (toolKey === "Write" || toolKey === "Edit")
      ? // Write/Edit only require approval when targeting the active space's
        // shared workspace (`spaces/<spaceId>/workspace/...`). The default
        // case — writing to the conversation's private workspace — runs
        // without prompting, matching pre-spaces behavior. Cross-space
        // writes are denied by the tool itself; we still return `true`
        // here so the user sees the prompt and can confirm the agent
        // attempted something disallowed.
        (input: unknown) => {
          const filePath = (input as { file_path?: unknown })?.file_path;
          if (typeof filePath !== "string") return false;
          return isAnySpacePath(filePath);
        }
      : approvalRequired && toolKey === "closeTabs"
      ? async (input: unknown) => {
          const cid = getCid();
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
        //
        // Inline `code` with `kind: "read"` whose AST passes the static check
        // skips approval on ANY origin. The static check is the trust mechanism
        // for reads — it ensures no DOM/storage/network mutation, no clicks,
        // no fetch, no navigation. Same exfiltration surface as snapshot/readPage,
        // both of which already run ungated.
        //
        // Inline `code` with `kind: "write"` (or `kind: "read"` whose AST is
        // rejected — treated as a misclassified write) falls through to the
        // standard tab-tool allowlist check: skip on user-allowlisted origins,
        // gate elsewhere.
        async (input: unknown) => {
          const typed = input as {
            scriptRef?: unknown;
            code?: unknown;
            kind?: "read" | "write";
          };
          if (typed?.scriptRef != null && typed.code == null) return false;

          // Verified-read fast path: kind: "read" + AST clean.
          if (typed.kind === "read" && typeof typed.code === "string") {
            const check = staticReadCheck(typed.code);
            if (check.ok) {
              // Verified read: skip approval on ANY origin. The static check
              // is the trust mechanism — it ensures the script can't mutate
              // the page, modify storage, navigate, or call network. The
              // allowlist is only consulted for writes (and for AST-rejected
              // reads, treated as writes per the table below).
              return false;
            }
            console.warn(
              "[executeOnPage] kind: read but static check rejected:",
              check.reason,
            );
          }

          return tabToolNeedsApproval(input);
        }
      : approvalRequired && isTabTool
        ? (input: unknown) => tabToolNeedsApproval(input)
        : approvalRequired;

  /**
   * Mode-aware wrapper around `askModeNeedsApproval`. The conversation's
   * current `mode` decides which gating policy applies:
   *
   *   - "ask"  → fall through to `askModeNeedsApproval` (the existing
   *              per-tool chain: tab allowlist, scriptRef short-circuit,
   *              executeOnPage verified-read fast path, executePython
   *              network gate, closeTabs auto-approve). This preserves
   *              every pre-modes behavior verbatim.
   *   - "plan" → consult the conversation's plan. With no plan, only
   *              `proposePlan` can run (and it's still gated — the user
   *              reviews and Approves to set the plan). With a plan,
   *              in-plan calls skip approval; off-plan calls gate.
   *              `proposePlan` itself is ALWAYS gated (any mode), so
   *              re-proposing extends the plan via the SDK's approval
   *              flow.
   *   - "act"  → skip approval for everything, EXCEPT executePython
   *              with `allow_network: true` when a plan exists with
   *              `allowNetwork: false`. The network floor binds even in
   *              Act mode: it's a hard "this conversation has agreed not
   *              to make network calls" rule, not just an Ask-mode prompt.
   *
   * The headless `autoApprove` wrapper is layered OUTSIDE this dispatch
   * (see `needsApprovalWithHeadless` below) and always wins — auto-approve
   * runs skip approval regardless of mode.
   */
  const needsApproval = approvalRequired
    ? async (input: unknown, opts: unknown): Promise<boolean> => {
        // Pin cid ONCE at entry so all downstream reads in this
        // dispatch (resolveModeAndPlan, isInPlan → resolveTabFromInput)
        // refer to the same conversation even if the user switches
        // conversations during an await. Without this pin, a mid-flight
        // switch could resolve `mode`/`plan` against conversation A and
        // then resolve the tab handle against conversation B's tab map
        // — silently mixing plan A's site list with B's tabs.
        const cid = getCid();
        const { mode, plan } = await resolveModeAndPlan(cid);

        if (mode === "act") {
          // proposePlan is ALWAYS gated, in any mode. Without this,
          // Act mode would let the model silently mint a fresh plan
          // (with arbitrary sites + allowNetwork) without user
          // confirmation — and in-plan calls then skip approval, so
          // the agent could broaden its own boundary unilaterally.
          // Matches the contract documented in the JSDoc above and
          // mirrors the explicit `proposePlan` gate in the "plan"
          // branch below.
          if (toolKey === "proposePlan") return true;
          // Network floor: even in Act mode, a plan that disallows
          // network blocks Python network calls. Without this the model
          // could quietly exfiltrate via Python after the user picked
          // "no network" in Plan mode and switched to Act for speed.
          if (
            toolKey === "executePython" &&
            (input as { allow_network?: unknown })?.allow_network === true &&
            plan &&
            !plan.allowNetwork
          ) {
            return true;
          }
          return false;
        }

        if (mode === "plan") {
          // proposePlan is ALWAYS gated — the prompt IS the approval flow
          // that lets the user review/edit/approve the plan. Without this
          // explicit branch, isInPlan would return true (proposePlan is
          // "in any plan") and we'd skip the prompt the user needs to see.
          if (toolKey === "proposePlan") return true;
          // No plan yet → only proposePlan can run (handled above; every
          // other gated tool prompts). The user is expected to call
          // proposePlan first; off-plan calls re-prompt until they do.
          if (!plan) return true;
          return !(await isInPlan(toolKey, input, plan, cid));
        }

        // mode === "ask": defer to existing per-tool logic.
        if (typeof askModeNeedsApproval === "function") {
          return (askModeNeedsApproval as (
            i: unknown,
            o: unknown,
          ) => boolean | Promise<boolean>)(input, opts);
        }
        // approvalRequired === true and askModeNeedsApproval is the
        // boolean fallback (a tool that requires approval but has no
        // per-tool override): default to gating.
        return askModeNeedsApproval as boolean;
      }
    : askModeNeedsApproval;

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
          const cid = getCid();
          const policy = cid ? headlessRunPolicies.get(cid) : undefined;
          if (policy?.autoApprove) return false;
          return (
            needsApproval as (i: unknown, o: unknown) => Promise<boolean>
          )(input, opts);
        }
      : approvalRequired
        ? async () => {
            const cid = getCid();
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
    // Auto-extend the plan when the user just approved (or is about to
    // run via skip-approval) a call that would otherwise re-prompt in
    // the future for the same reason. Two cases:
    //
    //   - Plan mode: option-C deviation handling. User approves an
    //     off-plan call (new site or executePython+network when
    //     plan.allowNetwork=false); extend the plan so subsequent calls
    //     in the same conversation skip the re-prompt.
    //
    //   - Act mode: the only thing that can gate is executePython+network
    //     when plan.allowNetwork=false (the spec's "always-protected
    //     network floor"). Without auto-extension here, every such call
    //     prompts forever — terrible UX in Act mode where the user opted
    //     out of approvals. So we flip allowNetwork on the first approval,
    //     mirroring Plan mode's behavior. Site extension does NOT apply
    //     in Act mode (sites always skip; there's no approval gesture).
    //
    // Capture cid once at entry, BEFORE the auto-extension block
    // below. Every chatDb / handle-map operation reachable from this
    // tool call — the auto-extension block (including the mode/plan
    // read via resolveModeAndPlan), the tool's own execute via
    // `ctx.session`, and resolveTabFromInput / capture stores — pins
    // to this snapshot. So if the user switches conversations
    // mid-tool-await, the in-flight call still reads, decides, and
    // writes against the conversation that originated it.
    const cid = getCid();
    capturedToolOrigins.delete(options.toolCallId);

    // Runs BEFORE the tool's body so the extension is durable even if
    // the tool throws.
    try {
      const { mode, plan } = await resolveModeAndPlan(cid);
      if (plan && (mode === "plan" || mode === "act")) {
        // Resolve target origin for tab-tools (best effort, Plan mode only).
        let targetOrigin: string | undefined;
        if (
          mode === "plan" &&
          toolKey !== "executePython" &&
          toolKey !== "proposePlan"
        ) {
          const resolved = await resolveTabFromInput(cid, input);
          if (resolved?.tab.url) {
            try {
              targetOrigin = new URL(resolved.tab.url).origin;
            } catch {
              // skip
            }
          }
        }
        const decision = planExtensionForCall({
          toolKey,
          inputAllowNetwork:
            (input as { allow_network?: unknown })?.allow_network === true,
          targetOrigin,
          plan,
        });
        if (decision.kind === "site" && cid) {
          await extendPlanWithSite(cid, decision.origin);
          await savePlanExtensionMarker(cid, {
            kind: "site",
            origin: decision.origin,
            extendedAt: Date.now(),
          });
        } else if (decision.kind === "network" && cid) {
          await flipPlanNetwork(cid);
          await savePlanExtensionMarker(cid, {
            kind: "network",
            extendedAt: Date.now(),
          });
        }
      }
    } catch (err) {
      console.warn("[plan] auto-extend failed; tool call proceeds:", err);
    }

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
      notifyAgentStatus(true, {
        tabId: resolved?.tabId ?? null,
        color: await ensureAgentColor(cid),
        conversationId: cid,
      });
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
      // Look up the conversation's spaceId so the fallback session
      // mounts the right shared space workspace.
      let fallbackSpaceId: string | null = null;
      if (cid) {
        try {
          const conv = await chatDb.getConversation(cid);
          fallbackSpaceId = conv?.spaceId ?? null;
        } catch {
          // chatDb unavailable (background asleep / SW restart); fall
          // back to no-space. Worst case: spaces/<id>/workspace reads
          // are denied this turn — recovers on the next call.
        }
      }
      const baseCtx = (options.experimental_context as ToolContext | undefined)
        ?? buildExtensionToolContext(cid, fallbackSpaceId);
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
          const cid = getCid();
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

/**
 * Tear down per-run state at terminal status (success / error / abort).
 *
 * @param conversationId  The cid whose overlays to clear. When provided,
 *   ONLY tabs owned by this cid have their overlays cleared — peer parallel
 *   runs (other top-level conversations OR sibling subagents under the same
 *   parent) keep their overlays. When omitted (legacy callers / broad sweep),
 *   every overlay is cleared, equivalent to the pre-refactor behavior.
 *
 * Tool aborts and CDP session detach are global (per-realm singletons) and
 * always run regardless of `conversationId` — the abort controllers and
 * debugger attachments live in module scope and are shared by all parallel
 * runs in this realm, so we can't scope them per-cid without a deeper
 * refactor. In practice the only impact is that a finishing run aborts any
 * mid-flight tool calls of peer runs in the same realm; the peer run's
 * abort-aware tool wrapper handles the resulting AbortError cleanly.
 */
export function resetAgentIndicator(
  conversationId?: string | null,
): void {
  if (agentActive) {
    agentActive = false;
    void resetAgentIndicatorImpl(conversationId ?? null);
  } else {
    // Even if `agentActive` is already false, the per-tab map may still hold
    // entries from this cid's prior tool calls. Clear them.
    void resetAgentIndicatorImpl(conversationId ?? null);
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

async function resetAgentIndicatorImpl(
  conversationId: string | null,
): Promise<void> {
  try {
    const { resetAgentIndicator: resetPerTab } = await import("./agent-indicator");
    await resetPerTab(conversationId);
  } catch {
    // Best-effort.
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
 * Record the connectors, skills, and active-space file references invoked in
 * a finished agent step onto the conversation row, so the Context card can
 * show them live (without waiting for end-of-turn message persistence).
 * Fire-and-forget; failures are swallowed. Main agent only — subagent steps
 * are not recorded here.
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

  const cid = conversationId;
  const persist = async (): Promise<void> => {
    try {
      const conv = await chatDb.getConversation(cid);
      if (!conv) return;

      // `spaceId` must be read INSIDE the persist closure (under the
      // serialized write queue) so we use the freshest value. Today the
      // conversation's space is fixed at creation, but reading it lazily
      // keeps us correct if that ever changes.
      const { connectorIds, skillNames, spaceFiles } = scanToolUsage(
        toolCalls,
        conv.spaceId ?? null,
      );
      if (
        connectorIds.length === 0 &&
        skillNames.length === 0 &&
        spaceFiles.length === 0
      ) {
        return;
      }

      const mergedConnectors = mergeDistinct(conv.usedConnectorIds, connectorIds);
      const mergedSkills = mergeDistinct(conv.loadedSkillNames, skillNames);
      const mergedSpaceFiles = mergeDistinct(
        conv.referencedSpaceFiles,
        spaceFiles,
      );

      // Note: we intentionally do NOT bump `updatedAt` here (unlike setTodos) —
      // recording tool usage shouldn't reorder conversations or trigger sidebar
      // churn on every step.
      const updates: {
        usedConnectorIds?: string[];
        loadedSkillNames?: string[];
        referencedSpaceFiles?: string[];
      } = {};
      if (mergedConnectors) updates.usedConnectorIds = mergedConnectors;
      if (mergedSkills) updates.loadedSkillNames = mergedSkills;
      if (mergedSpaceFiles) updates.referencedSpaceFiles = mergedSpaceFiles;
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

  // Pin the conversation id for this transport's lifetime in a local
  // constant. Every downstream closure (step callbacks, completion-check
  // wiring, system-prompt builder, usage recorders) reads from this
  // constant instead of the module-scope `agentConversationId` global,
  // which the SW agent host clobbers on every concurrent `setAgentContext`
  // call. The fallback to the global keeps legacy renderer callers that
  // never passed a conversationId working unchanged; production SW always
  // passes one through `agent-host/bootstrap.ts`.
  const transportCid = (): string | null =>
    conversationId ?? agentConversationId;

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

  const browserTools = createBrowserToolSet(conversationId);

  // The completion-check evaluator runs WITHOUT tools — single-shot
  // `generateObject` against the conversation context and the captured
  // tool-call trace. The earlier with-tools mode was removed (it
  // dominated end-of-turn latency, and the dimensions that benefited
  // from it have since been retired). See `completion-check/evaluator.ts`.

  // Under SW-host the MCP registry singleton lazily resolves a direct
  // reference to `backgroundMcpRegistry` on construction (so reads
  // bypass chrome.runtime.sendMessage, which the SW can't deliver to
  // itself). Await that resolution before reading tools so the agent
  // doesn't start a turn with an empty tools array.
  await getMcpRegistry().ready();

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
    instructions += `\n\nYou are chatting from the space "${spaceName}" (id: ${spaceId}). When saving space-scoped memories, use \`scope: "space"\`.`;

    // Per-space user-defined instructions, edited in the home Spaces page.
    try {
      const space = (await storage.getSpaces()).find((s) => s.id === spaceId);
      const text = space?.instructions?.trim();
      if (text) {
        instructions += `\n\n### Space instructions\n\n${text}`;
      }
    } catch {
      // Storage read failure is non-fatal; the agent runs without the
      // per-space instructions block.
    }
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
  const tcid = transportCid();
  const conv = tcid ? await chatDb.getConversation(tcid) : null;
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

  // The editing-artifact block is NOT baked here. The transport may be built
  // against a stale/null conversationId (it's constructed asynchronously while
  // the edit conversation id is assigned), which would omit the block. Instead
  // it's injected per-turn in `prepareCall` below, keyed on the live
  // `agentConversationId`, so it's always present and current.

  // The tab legend is intentionally NOT appended to `instructions` here.
  // ownedLtids and tab URLs change mid-conversation (navigate adds a tab,
  // user closes a tab, etc.); a static legend baked at transport-construction
  // time would go stale. Instead we build it just-in-time inside `prepareCall`
  // below so every model call sees the live state.

  const memories = await memoryDb.list(spaceId);
  if (memories.length > 0) {
    const memoryList = memories
      .map((m) => {
        // Show the scope so the agent knows whether a saved fact is global
        // or project-specific without having to recall it. "space" means
        // scoped to the active space; "user" means global.
        const scopeLabel = m.spaceId === null ? "user" : "space";
        return `- [${m.type}] [${scopeLabel}] ${m.title}: ${m.description}`;
      })
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

    instructions += `\n\n## Available Skills\n\nYou have access to the following skills. Each skill is knowledge you can load on demand. When a user's request matches a skill's description, call skill({ name }) to load its full instructions into the conversation BEFORE you start the work — do this even when you think you already know how, because skills carry workflow and verification steps that are easy to skip from memory. Already knowing the relevant API or concept is not a reason to skip loading the matching skill.\n\n${skillsSection}\n\nTo install a new skill from a URL or GitHub repo, use install_skill({ source }).\nTo read a file bundled with a skill, use Read({ file_path }) with the skill's path (e.g. "/skills/<name>/references/<file>").\nTo author and install a new skill you've drafted for the user, use create_skill.`;
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

      // Resolve the subagent's space color so its CUA loop's overlay
      // glow inherits the parent space's color (an incognito-isolated
      // subagent has spaceId=null and therefore no tint).
      const childSpaceId = cfg.toolContext.session?.spaceId ?? null;
      let childSpaceColor: string | null = null;
      if (childSpaceId != null) {
        try {
          const spaces = await storage.getSpaces();
          childSpaceColor =
            spaces.find((s) => s.id === childSpaceId)?.colors?.[0] ?? null;
        } catch {
          // best-effort; fall back to null tint
        }
      }

      const result = await cuaProvider.runLoop({
        model: cuaModel,
        driver: extensionDriver,
        tabId,
        modelId: cuaActualModelId,
        task: cfg.userMessage,
        systemPrompt: cfg.systemPrompt,
        maxSteps: cfg.agentDef.maxSteps ?? 40,
        // Stamp the child's cid + color so the CUA loop's per-tab
        // overlay state correctly attributes ownership. Without these,
        // a peer subagent's terminal-state teardown could clear this
        // subagent's overlay (and vice versa), because the per-tab
        // map keys on tabId but stamps cid for the ownership check.
        conversationId: cfg.childConversationId,
        spaceColor: childSpaceColor,
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
      const uiMessageStream = streamResult.toUIMessageStream({
        // Without an explicit `generateMessageId`, the AI SDK leaves
        // the start chunk's `messageId` undefined → readUIMessageStream
        // initializes `state.message.id` to `""` → every persisted
        // assistant chunk for this subagent run upserts to the same
        // empty-id chat-db row, collapsing multi-step transcripts and
        // colliding across runs.
        generateMessageId: () => crypto.randomUUID(),
      });
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
      // Pin the delegate wrapper to this transport's conversation id —
      // omitting the cid arg would default to `null` and the wrapper
      // would resolve via the mutable module-scope `agentConversationId`
      // on every read, which is wrong under SW-host where N concurrent
      // runs share the SW realm. Other tools in `parentTools` already
      // pass `cid` through `createBrowserToolSet(conversationId)`; this
      // closes the last gap.
      delegate: toSDKTool(delegateTool, "delegate", conversationId),
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

  // Per-transport token tracker. Holds the running total for THIS
  // conversation's loop. Replaces the module-scope `lastTotalTokens`
  // global, which races across concurrent SW transports (each run
  // would overwrite the other's count and trigger compaction on the
  // wrong conv's threshold). We still mirror to the module global on
  // each step so legacy renderer-side readers (`getLastTotalTokens`)
  // that pre-date SW-host parallelism keep returning a reasonable
  // last-seen value, but the compaction trigger here uses the local.
  let transportLastTotalTokens = 0;

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
    const cid = transportCid();
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
      // Scope the awareness block to the conversation's own window, not
      // whichever window Chrome currently has focused. Without this,
      // two parallel chats in two different windows would each see the
      // OTHER chat's tabs in their awareness section — and would happily
      // selectTab a foreign-window handle and navigate it. The lazy
      // resolver covers the case where the SW host's eager pre-resolve
      // at RUN_START hadn't completed yet (cache miss). Undefined falls
      // back to the driver's `chrome.windows.getCurrent()` default
      // (legacy behavior; correct for single-window or test setups).
      const scopedWindowId = await ensureAgentWindow(cid);
      const openTabs = await extensionDriver.listTabs(scopedWindowId);
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
      // Workspace-files block: enumerate /workspace per turn so the agent
      // sees its own artifacts (saveAs outputs, executePython writes,
      // Write tool files) even after long-conversation compaction prunes
      // the original tool-result messages. Symmetric to the tab legend
      // and site-skill catalog blocks injected here. Empty for fresh
      // conversations (no agent-written files yet).
      const cid = transportCid();
      const wsBlock = cid ? await buildWorkspaceFilesBlock(cid).catch(() => "") : "";

      // Fetch the conversation row ONCE per turn and reuse it for both the
      // editing-artifact block and the mode/plan block (previously two separate
      // chatDb.getConversation reads). Read per-turn (keyed on the live
      // agentConversationId) to dodge the transport-build race where
      // conversationId isn't settled, and so a mode switch / plan approval /
      // edit-target change mid-conversation takes effect on the next turn.
      let convRow: Awaited<ReturnType<typeof chatDb.getConversation>> | null = null;
      if (cid) {
        try {
          convRow = await chatDb.getConversation(cid);
        } catch (err) {
          // Same fallback as resolveModeAndPlan: on a read failure fall through
          // to Ask-mode semantics (no mode block) and omit the edit block. The
          // user gets prompted per tool call rather than the agent running
          // unconstrained — safe default.
          console.warn(
            "[agent] conversation refresh failed; falling back to Ask mode",
            err,
          );
        }
      }

      // Editing-artifact block: when this conversation is editing an artifact,
      // inject its id + manifest + current HTML so the agent edits inline via
      // update_artifact.
      let editBlock = "";
      if (convRow?.editingArtifactId) {
        try {
          const { loadArtifact } = await import("@/lib/artifacts/registry");
          const art = await loadArtifact(convRow.editingArtifactId);
          if (art) editBlock = buildEditingArtifactBlock(art);
        } catch {
          /* best-effort; omit the block on failure */
        }
      }

      // Per-turn mode + plan injection.
      let modeBlock = "";
      let activeToolsOverride: string[] | undefined;
      {
        const conv = convRow;
        if (conv?.mode === "plan") {
          if (!conv.plan) {
            modeBlock = `## Plan mode

You are in Plan mode. Your FIRST action MUST be \`proposePlan\` — do not call any other approval-gated tool until the user approves the plan.

Be specific in \`sites\` — list every origin you intend to touch. Set \`allowNetwork: true\` ONLY if the task requires \`executePython\` with outbound network access (most tasks don't).

If the user clicks 'Make changes', revise the plan based on their feedback and call \`proposePlan\` again.`;
            // Hard enforcement: restrict the available tool set to just
            // proposePlan so the model can't take any other action this
            // turn. Once the plan is approved, the next turn's prepareCall
            // sees conv.plan exists and lifts this restriction.
            activeToolsOverride = ["proposePlan"];
          } else {
            const sitesList =
              conv.plan.sites.length > 0
                ? conv.plan.sites.join(", ")
                : "(none yet — call proposePlan to extend)";
            modeBlock = `## Plan mode (plan approved)

Sites: ${sitesList}
Network access: ${conv.plan.allowNetwork ? "permitted" : "not permitted"}

Stay within the approved sites. If you need to touch a site not listed, call \`proposePlan\` again to extend the plan; the user will approve the extension. Do NOT use sites outside the list without re-proposing.`;
          }
        }
      }

      const baseInstructions =
        typeof callArgs.instructions === "string" ? callArgs.instructions : "";
      // Append blocks; any can be empty. Mode block goes first (framing),
      // then situational state (legend, workspace), then the editing-artifact
      // block. Double-newline separators render them as distinct sections.
      const tail = [modeBlock, legend, wsBlock, editBlock].filter(Boolean).join("\n\n");
      return {
        ...callArgs,
        instructions: tail ? `${baseInstructions}\n\n${tail}` : baseInstructions,
        // Cast: TS infers `keyof TOOLS` narrowly here because `tools` is a
        // union (headless filtered Record<string,...> vs the static base
        // shape) — the intersection of keys collapses. Runtime: `proposePlan`
        // is a real key in the agent's tools record, so the SDK accepts it.
        ...(activeToolsOverride && {
          activeTools: activeToolsOverride as never,
        }),
      };
    },
    onStepFinish: (stepResult) => {
      const usage = stepResult.usage;
      if (usage.inputTokens != null || usage.outputTokens != null) {
        transportLastTotalTokens =
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        // Mirror to the legacy module global for any reader that pre-
        // dates the per-transport switch. Best-effort and stale across
        // concurrent transports — never used by the compaction trigger
        // below.
        lastTotalTokens = transportLastTotalTokens;
      }
      // Once the compaction threshold trips, set the flag so stopWhen
      // breaks the loop at the next step boundary. We don't unset on a
      // false read — once we've decided to compact, see the decision
      // through. `modelDef` is the transport's pinned `ModelDefinition`,
      // also captured in this closure, so the threshold check is
      // race-free against concurrent transports on different models.
      if (
        transportLastTotalTokens > 0 &&
        shouldCompact(transportLastTotalTokens, modelDef)
      ) {
        needsMidStreamCompaction = true;
      }
      // Record connectors/skills used this step onto the conversation row so
      // the Context card surfaces them live (mirrors how todoWrite persists
      // todos mid-turn, instead of waiting for end-of-turn message persistence).
      void recordToolUsageForStep(transportCid(), stepResult.toolCalls);
      // Persist the token/cost usage snapshot for the header Context popover.
      // Fire-and-forget; serialized per-conversation alongside tool usage.
      void recordUsageForStep(transportCid(), {
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
    getActiveConversationId: () => transportCid(),
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
      //
      // Capture the turn-snapshot locals BEFORE the first await. The
      // module-level `lastCatalogDomains` / `lastActiveUrl` /
      // `lastTurnBaselineCount` are overwritten by the next turn's
      // `prepareCall`; without snapshotting, a slow curator closure would
      // see turn N+1's values and misattribute candidates from turn N to
      // the wrong domain. (Same shape of bug the wait-for-persist fix
      // resolved one layer up, but on the variables instead of the
      // message stream.)
      const turnConvId = lastTurnConversationId;
      const turnCatalogDomains = lastCatalogDomains.slice();
      const turnActiveUrl = lastActiveUrl;
      const turnBaseline = lastTurnBaselineCount;
      void (async () => {
        try {
          if (turnConvId !== cid) {
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
          await waitForAssistantPersist(cid, turnBaseline);
          const persisted = await chatDb.getMessages(cid);
          const allMessages = persisted as unknown as {
            role: string;
            parts?: unknown[];
          }[];
          // Slice from the captured baseline so we ONLY pass this turn's
          // messages to the extractor. Without the slice, a long-running
          // conversation would re-extract every prior turn's executeOnPage
          // parts on every approval, attributing old work to the current
          // domain.
          const messages = allMessages.slice(turnBaseline);
          if (DEBUG_CURATOR) {
            console.error(
              `[curator] approved conv=${cid} catalogDomains=[${turnCatalogDomains.join(",")}] activeUrl=${turnActiveUrl ?? "?"} baseline=${turnBaseline} persisted=${allMessages.length} turnSlice=${messages.length}`,
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
            catalogDomains: turnCatalogDomains,
            activeUrl: turnActiveUrl,
          });
          // Notes-only trigger: even with no reusable script, a turn that hit
          // friction (errored/timed-out tool calls) on a catalog domain is
          // worth curating a durable site note for.
          const notableDomain = detectNotableActivityDomain({
            messages,
            catalogDomains: turnCatalogDomains,
            activeUrl: turnActiveUrl,
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
