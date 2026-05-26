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
 */

import type { BrowserDriver, BrowserTabInfo, TabId } from "./browser-driver";
import type { TodoItem } from "../../types";

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
}

export interface ToolContext {
  driver: BrowserDriver;
  session?: ToolSession;
  /** AbortSignal forwarded from the agent loop, when the SDK supplies one. */
  signal?: AbortSignal;
}

/**
 * Convenience: derive a stable handle for a tab id, falling back to the
 * default `t<id>` format when no session-level handle map is available.
 */
export function handleForTab(ctx: ToolContext, tabId: TabId): string {
  return ctx.session?.getOrCreateHandle?.(tabId) ?? `t${tabId}`;
}

/**
 * Resolve a `tab` arg (a stable handle like `t1`) to a concrete tab id.
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
  const tabId = ctx.session?.resolveHandle?.(handle);
  if (tabId == null) {
    throw new ToolTabResolutionError(
      `Unknown tab handle "${handle}". Call listTabs to see available handles, or navigate to open a new tab.`,
    );
  }
  return tabId;
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
