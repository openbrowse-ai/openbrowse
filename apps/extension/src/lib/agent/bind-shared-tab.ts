/**
 * Helper for the side panel's "Sharing X" pill flow. When the user submits
 * the first message of a new conversation with a shared active tab, this
 * sends `BIND_ACTIVE_TAB_TO_CONVERSATION` to the background worker (same
 * path `selectTab` uses) and pins the tab as the agent's target so the
 * legend marks it `[active]` on the very first model call.
 *
 * Pure-ish: the chrome.runtime / setTargetTabId callers are injected so
 * this is unit-testable without a real extension context.
 */
export interface BindSharedTabDeps {
  send: (msg: {
    type: "BIND_ACTIVE_TAB_TO_CONVERSATION";
    conversationId: string;
    tabId: number;
  }) => Promise<unknown>;
  setTargetTabId: (tabId: number | null) => void;
}

export interface BindSharedTabArgs {
  conversationId: string;
  tabId: number | null;
}

/**
 * Returns `true` when the bind succeeded, `false` when there was no tab
 * to bind, `false` when the background worker reported failure
 * (`{ ok: false }`), and `false` (swallowing the error) when the
 * background worker was unreachable. We only pin the target tab on a
 * confirmed success so the legend never marks a tab `[active]` that
 * wasn't actually bound into the conversation's owned set. Errors are
 * intentionally not propagated — the agent recovers via
 * `listTabs`/`selectTab` on its first turn if needed.
 */
export async function bindSharedTab(
  args: BindSharedTabArgs,
  deps: BindSharedTabDeps,
): Promise<boolean> {
  if (args.tabId == null) return false;
  try {
    const res = await deps.send({
      type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
      conversationId: args.conversationId,
      tabId: args.tabId,
    });
    // The background handler catches its own errors and resolves with
    // `{ ok: false, error }` instead of rejecting. Honor that so a
    // failed bind doesn't pin a tab that was never owned. An `undefined`
    // response is treated as success (legacy fire-and-forget handlers).
    if (
      res != null &&
      typeof res === "object" &&
      "ok" in res &&
      (res as { ok?: unknown }).ok === false
    ) {
      return false;
    }
    deps.setTargetTabId(args.tabId);
    return true;
  } catch {
    return false;
  }
}
