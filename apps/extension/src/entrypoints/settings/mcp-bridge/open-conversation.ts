/**
 * Helpers for opening a chat conversation in the home-app tab.
 *
 * Used by both `RecentTaskRow` (completed MCP task rows) and
 * `ActiveTaskCard` (running MCP task rows). The Settings page is its
 * own top-level entrypoint, so we can't mutate `window.location.hash`
 * and expect the home app to react — we have to navigate explicitly
 * to the home.html URL with the conversation id as a hash fragment.
 *
 * See `_shared/route.ts` in the home app — a bare conversation id is
 * a valid hash route.
 *
 * Focus-existing semantics (B1): when an existing tab already points
 * at this conversation, focus it instead of opening a duplicate. The
 * matching is exact on the conversation hash; a home tab pointing at
 * a different conversation will NOT be reused.
 */

/**
 * Build the hash fragment for a conversation deep-link. Pure helper,
 * exported for unit testing.
 */
export function buildOpenConversationHash(conversationId: string): string {
  return `#${conversationId}`;
}

/**
 * Build the absolute extension URL to the home app focused on a
 * given conversation. Pure helper, exported for unit testing.
 */
export function buildOpenConversationUrl(conversationId: string): string {
  return `${chrome.runtime.getURL("home.html")}#${conversationId}`;
}

/**
 * Pure helper, exported for unit testing: build the
 * `chrome.tabs.query` filter that finds existing home tabs (any
 * conversation, any state).
 */
export function buildHomeTabQuery(): { url: string } {
  // chrome.tabs.query's `url` matcher supports wildcards in the path
  // segment. Hash fragments are NOT considered in the match — they
  // never appear in the canonical tab URL the matcher sees. We
  // filter on conversation id ourselves after the query.
  return { url: `${chrome.runtime.getURL("home.html")}*` };
}

/**
 * Pure helper, exported for unit testing: among a list of candidate
 * home tabs, find the one whose URL hash points at the target
 * conversation. Returns the first match's tab id, or null.
 *
 * Chrome's `tabs.query` returns URLs WITH the hash fragment included
 * for the same-origin extension tab, so a direct `endsWith` check on
 * `#<conversationId>` is reliable. Tabs whose URLs we can't parse
 * (e.g. about:blank during a load race) are skipped.
 */
export function findTabIdMatchingConversation(
  tabs: ReadonlyArray<{ id?: number; url?: string }>,
  conversationId: string,
): number | null {
  const hash = buildOpenConversationHash(conversationId);
  for (const t of tabs) {
    if (typeof t.id !== "number") continue;
    if (typeof t.url !== "string") continue;
    if (t.url.endsWith(hash)) return t.id;
  }
  return null;
}

/**
 * Open or focus a home tab at the given conversation. Used by
 * `ActiveTaskCard` and `RecentTaskRow`.
 *
 * Behaviour:
 *   1. Query all home tabs.
 *   2. If one already points at this conversation, focus it (update
 *      to active + raise its window).
 *   3. Otherwise create a new home tab at the conversation URL.
 *
 * Errors are caught and fall back to `window.open` so the caller
 * always lands SOMEWHERE — preferable to a silent failure when the
 * privileged tab APIs are unavailable for some reason (manifest
 * permissions changed, test env, etc.).
 */
export async function openOrFocusConversation(
  conversationId: string,
): Promise<void> {
  const url = buildOpenConversationUrl(conversationId);
  try {
    const tabs = await chrome.tabs.query(buildHomeTabQuery());
    const existingId = findTabIdMatchingConversation(tabs, conversationId);
    if (existingId != null) {
      // Raise the existing tab + its window.
      const tab = await chrome.tabs.update(existingId, { active: true });
      if (tab?.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return;
    }
    await chrome.tabs.create({ url, active: true });
  } catch {
    // Fall back to `window.open` so the user still lands on the
    // conversation even if the privileged APIs are unavailable.
    try {
      window.open(url, "_blank");
    } catch {
      // No further fallback — nothing we can do.
    }
  }
}

