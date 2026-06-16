import { tabRegistry } from "@/lib/agent/tab-registry";

export interface RequestCloseAgentTabsResult {
  ok: boolean;
  error?: string;
}

/**
 * Manually close a conversation's agent-owned tabs from the Context card.
 * Sends the same `CLOSE_AGENT_TABS` background message the closeTabs tool
 * uses, so the background closes the tabs, clears ownership, and broadcasts
 * `AGENT_TABS_CLOSED` (which surfaces the Undo toast). No-ops on empty input.
 *
 * Takes chrome `tabId`s (numbers) for caller convenience — the Context
 * card hydrates rows from `chrome.tabs.get` so it has live ctids in hand.
 * Internally translates each ctid to a LogicalTabId via the registry
 * before sending; ctids the registry doesn't know about (genuinely-gone
 * tabs) are dropped silently.
 */
export async function requestCloseAgentTabs(
  conversationId: string,
  tabIds: number[],
): Promise<RequestCloseAgentTabsResult> {
  if (!conversationId || tabIds.length === 0) {
    return { ok: false, error: "Nothing to close" };
  }
  const ltids = tabIds
    .map((ctid) => tabRegistry.toLogicalTabId(ctid))
    .filter((ltid): ltid is string => ltid != null);
  if (ltids.length === 0) {
    return { ok: false, error: "Nothing to close" };
  }
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "CLOSE_AGENT_TABS",
      conversationId,
      ltids,
    })) as { ok?: boolean; error?: string } | undefined;
    if (!res?.ok) {
      return { ok: false, error: res?.error ?? "Close failed" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
