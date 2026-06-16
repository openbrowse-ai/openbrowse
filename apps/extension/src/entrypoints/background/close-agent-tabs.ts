import { closeOwnedTabs, type CloseTabsUndo } from "./tab-scoping";

export interface CloseAgentTabsRequest {
  conversationId: string;
  /**
   * LogicalTabIds to close. The background handler resolves each ltid
   * back to a live `chrome.tabs.id` via `tab-registry` just before
   * `chrome.tabs.remove`. ltids whose ctid is no longer resolvable are
   * silently skipped (the underlying tab is already gone).
   */
  ltids: string[];
}

export interface CloseAgentTabsResponse {
  ok: boolean;
  undo?: CloseTabsUndo;
  error?: string;
}

/**
 * Background-side handler for the CLOSE_AGENT_TABS message sent by the
 * closeTabs tool. Closes the given owned tabs and returns the undo payload.
 */
export async function handleCloseAgentTabs(
  req: CloseAgentTabsRequest,
): Promise<CloseAgentTabsResponse> {
  if (!req.conversationId || !Array.isArray(req.ltids) || req.ltids.length === 0) {
    return { ok: false, error: "No tabs to close" };
  }
  try {
    const undo = await closeOwnedTabs(req.conversationId, req.ltids);
    return { ok: true, undo };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
