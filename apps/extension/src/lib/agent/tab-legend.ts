/**
 * Builds the dynamic "## Tabs in this conversation" block for the system
 * prompt. Pulled out of agent-transport so it can be tested without a live
 * chatDb / chrome.tabs.
 *
 * Owned-tabs only: the legend is the authoritative list of handles the
 * agent should pass as `tab` args. Tabs the user has open elsewhere do
 * NOT appear here unless the agent calls `selectTab` to bind them.
 */

import type { TabId } from "./driver";

export interface TabLegendInput {
  conversationId: string;
  ownedTabIds: number[];
  /**
   * Per-tab info fetcher. Should resolve with the live tab info, or reject
   * if the tab no longer exists (the legend renderer treats rejection as
   * "drop this entry").
   */
  getTab: (tabId: number) => Promise<{ url: string | undefined; title: string | undefined }>;
  /** Mint or retrieve a stable handle for the given (conversation, tabId). */
  getOrCreateHandle: (conversationId: string, tabId: number) => string;
  /** The currently-tracked active tab (used to mark `[active]`). May be null. */
  activeTabId: TabId | null;
}

export interface TabLegendEntry {
  handle: string;
  url: string;
  title: string;
  active: boolean;
}

export function isInternalChromeUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://")
  );
}

export async function buildTabLegendEntries(
  input: TabLegendInput,
): Promise<TabLegendEntry[]> {
  const entries: TabLegendEntry[] = [];
  for (const tabId of input.ownedTabIds) {
    let url: string | undefined;
    let title: string | undefined;
    try {
      const info = await input.getTab(tabId);
      url = info.url;
      title = info.title;
    } catch {
      // Tab no longer exists; skip.
      continue;
    }
    if (!url) continue;
    if (isInternalChromeUrl(url)) continue;
    const handle = input.getOrCreateHandle(input.conversationId, tabId);
    const cleanTitle = (title ?? "").trim() || "(untitled)";
    entries.push({
      handle,
      url,
      title: cleanTitle,
      active: input.activeTabId === tabId,
    });
  }
  return entries;
}

export function renderTabLegend(entries: TabLegendEntry[]): string {
  if (entries.length === 0) {
    return [
      "## Tabs in this conversation",
      "No tabs bound to this conversation yet. To bootstrap, call `navigate({ url })` (without a `tab` arg) to open a new background tab and receive its handle.",
    ].join("\n");
  }
  const lines = entries.map(
    (e) =>
      `- ${e.handle}: ${e.title} — ${e.url}${e.active ? "  [active]" : ""}`,
  );
  return [
    "## Tabs in this conversation",
    "Pass one of these handles as the `tab` argument to tab-tools.",
    ...lines,
  ].join("\n");
}
