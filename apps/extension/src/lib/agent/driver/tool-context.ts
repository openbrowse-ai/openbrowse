/**
 * Per-tool-call execution context. Threaded into every `BrowserTool.execute`
 * via the Vercel AI SDK's `experimental_context` channel. The agent transport
 * builds one of these and forwards it on every call.
 *
 * The contract is intentionally small:
 *
 *   - `driver`: required. Pure browser primitives. Always present.
 *   - `session`: optional. Carries extension-only conversation orchestration
 *     (tab handle assignment, conversation-to-tab binding). The bench harness
 *     leaves this undefined; tools that depend on it must guard accordingly.
 *
 * Tools that need extras beyond browser primitives + conversation state
 * should NOT extend this type. Extras belong in the extension wrapper layer
 * (`agent-transport.ts`), not in the portable tool surface.
 *
 * Logical tab ids
 * ===============
 * As of the LogicalTabId migration, the session's `resolveHandle` returns
 * a `LogicalTabId` (a UUID), not a `chrome.tabs.id` (a number). Tools that
 * call `resolveTabIdOrThrow` get a logical id back and must translate to
 * a chrome ctid via `tabRegistry.toChromeTabId(ltid)` before any driver
 * call (the driver's CDP / chrome.tabs methods take ctids).
 *
 * `TabId` (the driver-facing type) stays `number | string` so the bench
 * harness's Playwright driver — which uses opaque string ids — keeps
 * working unchanged. The extension's `ExtensionDriver` always sees
 * numbers; the tool layer is responsible for the translation.
 */

import type { BrowserDriver, BrowserTabInfo, TabId } from "./browser-driver";
import type { TodoItem } from "../../types";
import { tabRegistry } from "../tab-registry";

export interface ToolSession {
  /** The active conversation id, or null when running outside a conversation. */
  conversationId: string | null;
  /**
   * Bind newly-created tabs to the active conversation so the extension can
   * track agent-owned tabs across reloads. No-op in the bench harness.
   */
  bindTabsToConversation?: (tabIds: TabId[]) => Promise<void>;
  /**
   * Bind a single user-selected tab to the active conversation (used by
   * `selectTab` and the implicit host-tab fallback). No-op in the bench
   * harness.
   */
  bindActiveTabToConversation?: (tabId: TabId) => Promise<void>;
  /**
   * Map a real tab id → a stable handle (`t1`, `t2`, ...) for display to
   * the agent. Falls back to `t<id>` if not provided.
   */
  getOrCreateHandle?: (tabId: TabId) => string;
  /** Reverse-lookup a handle → real tab id. */
  resolveHandle?: (handle: string) => TabId | undefined;
  /**
   * True when the conversation owns the given tab (so the agent should
   * reuse it for subsequent navigations rather than spawning new ones).
   * Bench: always false — every navigate creates a fresh tab.
   */
  isAgentOwnedTab?: (tabId: TabId) => Promise<boolean>;
  /**
   * True when the conversation already has a tab group, so newly-selected
   * tabs should fold into it. Used by `selectTab`. Bench: always false.
   */
  hasOwnedTabGroup?: () => Promise<boolean>;
  /** Retrieve the current to-do list for this session. */
  getTodos?: () => Promise<TodoItem[]>;
  /** Replace the current to-do list for this session. */
  setTodos?: (todos: TodoItem[]) => Promise<void>;
  /**
   * Set when this session is running as a subagent. Carries the parent's
   * conversation id and the depth in the agent tree (root = 0, first-level
   * subagent = 1). Used to enforce the depth cap and to label child
   * conversations / tab groups with their parent's identity.
   *
   * `toolCallId` is the parent's `delegate` tool call id — used by
   * subagent-only tools (e.g. `setTaskTitle`) to broadcast UI events
   * keyed to a specific delegation block in the parent's chat.
   *
   * Absent on the root parent agent's session.
   */
  parent?: {
    conversationId: string;
    depth: number;
    toolCallId?: string;
  };
  /**
   * For `incognito` subagent runs: the windowId of the fresh incognito
   * window the runner opened. Tools that create tabs (e.g. `navigate`)
   * should pass this to `driver.createTab({windowId})` so the subagent's
   * tabs land in its own window rather than the user's active window.
   *
   * Absent on `inline` and `peer` runs (and on the root agent), in which
   * case tabs are resolved via `resolveNewTabWindowId` (root agent) or
   * fall back to the user's currently focused window.
   */
  targetWindowId?: number;
  /**
   * For `attached` (CUA) subagents: the parent tab handle the runner seeded
   * into this session's handle map. The CUA loop resolves this to the live
   * tab id to operate on.
   */
  cuaTabHandle?: string;
  /**
   * Resolve the window new agent-created tabs should open in for the root
   * agent. Tools that create tabs (e.g. `navigate`) call this when no
   * static `targetWindowId` is set, so a new tab lands in the same window
   * as the conversation (where the chat and the agent's existing tabs
   * live) rather than whatever window Chrome happens to have focused.
   *
   * Returns `undefined` when no window can be resolved (no owned tabs and
   * no live space window), in which case the caller omits `windowId` and
   * Chrome falls back to the focused window (legacy behavior).
   *
   * No-op / absent in the bench harness and on subagent sessions (which
   * use the static `targetWindowId` instead).
   */
  resolveNewTabWindowId?: () => Promise<number | undefined>;
}

export interface ToolContext {
  driver: BrowserDriver;
  session?: ToolSession;
  /** AbortSignal forwarded from the agent loop, when the SDK supplies one. */
  signal?: AbortSignal;
  /**
   * The AI SDK's tool-call id for this invocation, threaded through by
   * the toSDKTool wrapper. Used by tools that emit cross-component
   * events keyed to a specific call (e.g. `delegate` broadcasting
   * `SUBAGENT_CHILD_ASSIGNED` so the parent's `DelegateResult` block
   * can subscribe to live updates as soon as the child conversation
   * exists, before the tool finishes).
   */
  toolCallId?: string;
}

/**
 * Convenience: derive a stable handle for a tab id, falling back to the
 * default `t<id>` format when no session-level handle map is available.
 *
 * `tabId` here is the driver's `TabId` — for the extension this is the
 * `chrome.tabs.id` (number), which we register/lookup in the registry to
 * get the LogicalTabId the session's `getOrCreateHandle` then maps to a
 * stable `t<n>` handle. For the bench harness's PlaywrightDriver, `TabId`
 * is a string and the session is undefined, so we just stringify.
 */
export function handleForTab(ctx: ToolContext, tabId: TabId): string {
  if (!ctx.session?.getOrCreateHandle) return `t${tabId}`;
  // Extension path: ctid (number) → ltid (via registry) → handle.
  // Bench path: TabId is already a string; pass through.
  if (typeof tabId === "number") {
    const ltid = tabRegistry.registerExisting(tabId);
    return ctx.session.getOrCreateHandle(ltid);
  }
  return ctx.session.getOrCreateHandle(tabId);
}

/**
 * Resolve a `tab` arg (a stable handle like `t1`) to a driver-addressable
 * tab id (a `chrome.tabs.id` number on the extension; an opaque string in
 * the bench harness).
 *
 * The session's `resolveHandle` returns a LogicalTabId (string) on the
 * extension; we translate to ctid via the registry. Returns whatever the
 * session returned otherwise (bench harness path, where the session is
 * undefined or returns the driver's native id).
 *
 * This is the canonical entry point for every tab-interacting tool's
 * execute(): tools never pick a tab via the driver's "active" notion any
 * more — they always operate on the explicit handle the agent passed.
 *
 * Throws a structured `ToolTabResolutionError` so the SDK wrapper can
 * surface a clean message to the agent without a stack trace.
 */
export class ToolTabResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolTabResolutionError";
  }
}

export function resolveTabIdOrThrow(
  ctx: ToolContext,
  handle: string,
): TabId {
  const sessionResult = ctx.session?.resolveHandle?.(handle);
  if (sessionResult == null) {
    throw new ToolTabResolutionError(
      `Unknown tab handle "${handle}". Call listTabs to see available handles, or navigate to open a new tab.`,
    );
  }
  // Extension path: session returns LogicalTabId (string); translate via
  // the registry to a ctid (number) for the driver.
  if (typeof sessionResult === "string") {
    const ctid = tabRegistry.toChromeTabId(sessionResult);
    if (ctid == null) {
      // ltid is in the handle map but the registry can't resolve to a
      // live ctid — the underlying tab is gone (closed) but the handle
      // map's `dropLtid` cleanup hasn't fired yet, OR an SW restart
      // hasn't re-registered the ltid. Treat as resolution failure.
      throw new ToolTabResolutionError(
        `Tab handle "${handle}" no longer points to an open tab. Call listTabs to refresh handles, or navigate to open a new one.`,
      );
    }
    return ctid;
  }
  // Bench harness path: pass through whatever the session returned.
  return sessionResult;
}

export async function resolveTabOrThrow(
  ctx: ToolContext,
  handle: string,
): Promise<BrowserTabInfo> {
  const tabId = resolveTabIdOrThrow(ctx, handle);
  try {
    return await ctx.driver.getTab(tabId);
  } catch (err) {
    throw new ToolTabResolutionError(
      `Tab ${handle} (id=${String(tabId)}) is no longer available: ${
        err instanceof Error ? err.message : String(err)
      }. Call listTabs to refresh handles.`,
    );
  }
}

/**
 * Bind a tab (referenced by handle) into the active conversation so it
 * appears in the tab legend and can be addressed by subsequent tool calls.
 *
 * Resolution order mirrors `selectTab`:
 *   1. The session handle map (`resolveHandle`) — returns a LogicalTabId
 *      (string) on the extension; the registry then resolves to a ctid.
 *   2. A numeric fallback — the raw `chrome.tabs` id, for tabs the agent
 *      hasn't bound yet (e.g. user-opened tabs surfaced by `listTabs`).
 * The tab is verified to exist via `driver.listTabs()` before binding.
 *
 * Returns the driver-addressable tab id (a ctid number on the extension),
 * or `null` if the handle could not be resolved to a live tab. Does NOT
 * change the user's visible tab.
 *
 * Shared by the `selectTab` tool and the `delegate` tool's auto-bind path
 * for `attached` (CUA) subagents.
 */
export async function bindTabByHandle(
  ctx: ToolContext,
  handle: string,
): Promise<TabId | null> {
  const sessionResult = ctx.session?.resolveHandle?.(handle);
  let tabId: TabId | null = null;

  if (typeof sessionResult === "string") {
    // Extension path: ltid → ctid via registry.
    const ctid = tabRegistry.toChromeTabId(sessionResult);
    tabId = ctid ?? null;
  } else if (sessionResult != null) {
    tabId = sessionResult;
  }

  // Fallback: a user-opened tab may appear in listTabs under its numeric
  // chrome id before it is bound to the conversation. Only accept a strictly
  // all-digit handle — `parseInt("123abc")` would otherwise resolve a
  // malformed handle to a real tab.
  if (tabId == null && /^\d+$/.test(handle)) {
    tabId = Number(handle);
  }
  if (tabId == null) return null;

  const tabs = await ctx.driver.listTabs();
  const target = tabs.find((t) => t.id === tabId);
  if (!target) return null;

  await ctx.session?.bindActiveTabToConversation?.(tabId);
  return tabId;
}
