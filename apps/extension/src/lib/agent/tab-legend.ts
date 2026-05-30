/**
 * Builds the dynamic "## Tabs in this conversation" block for the system
 * prompt. Pulled out of agent-transport so it can be tested without a live
 * chatDb / chrome.tabs.
 *
 * Owned-tabs only: the legend is the authoritative list of handles the
 * agent should pass as `tab` args. Tabs the user has open elsewhere do
 * NOT appear here unless the agent calls `selectTab` to bind them.
 *
 * Sibling block "## Other open tabs" (see `renderOpenTabsAwareness`)
 * surfaces the rest of the user's open tabs as awareness only — the
 * agent must call `selectTab({ tab })` to bind them before they can be
 * passed as a `tab` arg to tab-acting tools.
 */

import type { TabId } from "./driver";

export interface TabLegendInput {
  conversationId: string;
  ownedTabIds: TabId[];
  /**
   * Per-tab info fetcher. Should resolve with the live tab info, or reject
   * if the tab no longer exists (the legend renderer treats rejection as
   * "drop this entry").
   */
  getTab: (tabId: TabId) => Promise<{ url: string | undefined; title: string | undefined }>;
  /** Mint or retrieve a stable handle for the given (conversation, tabId). */
  getOrCreateHandle: (conversationId: string, tabId: TabId) => string;
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

/**
 * Allowlist gate for URLs that may be sent to the LLM. The tab legend and
 * awareness blocks feed the user's open tabs into the *system prompt*, so
 * we restrict to ordinary web origins (`http`/`https`). This is an
 * allowlist, not a denylist: schemes like `file:` (local filesystem
 * paths), `about:`, `data:`, `view-source:`, `chrome:`, and extension
 * URLs are never exposed — both because they can leak sensitive local
 * context and because they're not actionable tab targets for the agent.
 */
export function isAgentVisibleUrl(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("https://") || url.startsWith("http://");
}

const MAX_TITLE_CHARS = 80;
const MAX_URL_CHARS = 200;

/**
 * Sanitize an attacker-controllable string (a page title or URL) before
 * interpolating it into the system prompt. Page titles are set by
 * arbitrary web content (`document.title`), so without this a malicious
 * page could embed newlines + markdown to forge a "## Tabs in this
 * conversation" heading or inject instructions into the prompt.
 *
 * Collapses ALL whitespace (including newlines, tabs, and other control
 * characters) to single spaces, trims, and truncates to `max` chars with
 * an ellipsis. The result is guaranteed to be single-line.
 */
export function sanitizeForPrompt(
  value: string | undefined,
  max: number,
): string {
  const collapsed = (value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max) + "…";
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
    // Allowlist: only ordinary web origins reach the prompt.
    if (!isAgentVisibleUrl(url)) continue;
    const handle = input.getOrCreateHandle(input.conversationId, tabId);
    const cleanTitle =
      sanitizeForPrompt(title, MAX_TITLE_CHARS) || "(untitled)";
    entries.push({
      handle,
      url: sanitizeForPrompt(url, MAX_URL_CHARS),
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

/**
 * Awareness-only listing of tabs the user has open in the current window
 * but which are NOT bound to this conversation. The agent should NOT pass
 * these handles directly to tab-acting tools; calling `selectTab({ tab })`
 * binds the tab into the conversation first (which is when it migrates
 * into the "## Tabs in this conversation" legend).
 *
 * Capped at MAX_AWARENESS_ENTRIES so a user with hundreds of tabs doesn't
 * blow up the system prompt.
 */
export interface OpenTabsAwarenessInput {
  conversationId: string;
  /** Tab ids already in the conversation (omit from the awareness list). */
  ownedTabIds: TabId[];
  /** All open tabs in the current window. Internal/extension URLs filtered. */
  openTabs: { id: TabId; url: string; title: string; active: boolean }[];
  getOrCreateHandle: (conversationId: string, tabId: TabId) => string;
  /** Cap the list. Defaults to {@link MAX_AWARENESS_ENTRIES}. */
  maxEntries?: number;
}

export const MAX_AWARENESS_ENTRIES = 20;

export interface OpenTabsAwarenessEntry {
  handle: string;
  url: string;
  title: string;
  active: boolean;
}

export function buildOpenTabsAwarenessEntries(
  input: OpenTabsAwarenessInput,
): { entries: OpenTabsAwarenessEntry[]; truncated: number } {
  const owned = new Set<TabId>(input.ownedTabIds);
  const cap = input.maxEntries ?? MAX_AWARENESS_ENTRIES;
  const result: OpenTabsAwarenessEntry[] = [];
  let truncated = 0;
  for (const t of input.openTabs) {
    if (owned.has(t.id)) continue;
    if (!t.url) continue;
    if (!isAgentVisibleUrl(t.url)) continue;
    if (result.length >= cap) {
      truncated++;
      continue;
    }
    const handle = input.getOrCreateHandle(input.conversationId, t.id);
    const cleanTitle =
      sanitizeForPrompt(t.title, MAX_TITLE_CHARS) || "(untitled)";
    result.push({
      handle,
      url: sanitizeForPrompt(t.url, MAX_URL_CHARS),
      title: cleanTitle,
      active: !!t.active,
    });
  }
  return { entries: result, truncated };
}

export function renderOpenTabsAwareness(
  entries: OpenTabsAwarenessEntry[],
  truncated = 0,
): string {
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e) =>
      `- ${e.handle}: ${e.title} — ${e.url}${e.active ? "  [user-active]" : ""}`,
  );
  const header = [
    "## Other open tabs",
    "Open in the user's browser but NOT bound to this conversation. To act on one, call `selectTab({ tab })` first — that binds it and moves it into the legend above.",
    ...lines,
  ];
  if (truncated > 0) {
    header.push(`(+${truncated} more — call listTabs to see all)`);
  }
  return header.join("\n");
}
