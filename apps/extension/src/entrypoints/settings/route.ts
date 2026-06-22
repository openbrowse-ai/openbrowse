/**
 * URL routing for `settings.html`. The active settings tab is encoded in
 * the query string as `?tab=<id>` so external callers (and the existing
 * `openSettingsTab(subTab)` helper) can deep-link without coordinating
 * with this module.
 *
 * The query string — rather than the hash — is the right channel here
 * because:
 *
 *   - external callers already use `?tab=` (see `lib/open-settings.ts`),
 *   - nothing in the background rewrites the settings URL, so a query
 *     param is durable across navigations,
 *   - the settings tab id is a fixed enum, not a free-form id, so URL
 *     encoding concerns are minimal.
 */

export const SETTINGS_TAB_IDS = [
  "general",
  "models",
  "connectors",
  "skills",
  "memory",
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTabId = "general";

function isSettingsTabId(value: string): value is SettingsTabId {
  return (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

/**
 * Parse the active tab from a search string (e.g. `window.location.search`
 * or a fully-qualified URL). Falls back to the default tab when the
 * `tab` param is missing or names an unknown tab.
 */
export function parseSettingsTab(search: string): SettingsTabId {
  // Tolerate either a bare query string or a full URL/path; `URLSearchParams`
  // accepts both via the "?…" prefix.
  const qs = search.startsWith("?") ? search : `?${search}`;
  const params = new URLSearchParams(qs);
  const tab = params.get("tab");
  if (tab && isSettingsTabId(tab)) return tab;
  return DEFAULT_SETTINGS_TAB;
}

/**
 * Format a search string (with leading `?` when non-empty) for the
 * given tab. The default tab is encoded as an empty string so the
 * canonical URL for "settings home" is just `/settings.html` — keeping
 * the address bar tidy when the user lands on the page without a deep
 * link.
 *
 * Other query params on the page are preserved when callers pass the
 * current `window.location.search` as `currentSearch`.
 */
export function formatSettingsSearch(
  tab: SettingsTabId,
  currentSearch = "",
): string {
  const qs = currentSearch.startsWith("?")
    ? currentSearch.slice(1)
    : currentSearch;
  const params = new URLSearchParams(qs);
  if (tab === DEFAULT_SETTINGS_TAB) {
    params.delete("tab");
  } else {
    params.set("tab", tab);
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}
