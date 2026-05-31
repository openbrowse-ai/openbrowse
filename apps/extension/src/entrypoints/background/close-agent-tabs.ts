import { closeOwnedTabs, type CloseTabsUndo } from "./tab-scoping";

export interface CloseAgentTabsRequest {
  conversationId: string;
  tabIds: number[];
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
  if (!req.conversationId || !Array.isArray(req.tabIds) || req.tabIds.length === 0) {
    return { ok: false, error: "No tabs to close" };
  }
  try {
    const undo = await closeOwnedTabs(req.conversationId, req.tabIds);
    return { ok: true, undo };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
