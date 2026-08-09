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
 *
 * The Memory tab additionally encodes the note being viewed as
 * `?tab=memory&note=<url-encoded OPFS path>` so a reload (or Back/Forward)
 * restores it. The full path is stored rather than a scope-relative one
 * because a global and a space-scoped note can share a filename. The path is
 * NOT trusted on read — the Memory view validates it against the currently
 * visible file set and falls back to the graph if it's stale or belongs to
 * another space.
 */

export const SETTINGS_TAB_IDS = [
  "general",
  "models",
  "connectors",
  "skills",
  "memory",
  "mcp-bridge",
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTabId = "general";

function isSettingsTabId(value: string): value is SettingsTabId {
  return (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

/**
 * Build params from a search string, tolerating a full URL, a path+search
 * string, or a bare query string (everything after the first "?" wins, and a
 * string without one is treated as the query itself).
 */
function searchParams(search: string): URLSearchParams {
  const qsIndex = search.indexOf("?");
  const rawQs = qsIndex >= 0 ? search.slice(qsIndex) : search;
  return new URLSearchParams(rawQs.startsWith("?") ? rawQs : `?${rawQs}`);
}

/**
 * Parse the active tab from a search string (e.g. `window.location.search`
 * or a fully-qualified URL). Falls back to the default tab when the
 * `tab` param is missing or names an unknown tab.
 */
export function parseSettingsTab(search: string): SettingsTabId {
  const tab = searchParams(search).get("tab");
  if (tab && isSettingsTabId(tab)) return tab;
  return DEFAULT_SETTINGS_TAB;
}

/**
 * Parse the memory note path from a search string. Returns null when absent
 * or empty. The value is a full OPFS path (e.g. `memory/andrew-chung.md`);
 * callers MUST validate it still exists and is in scope before using it.
 */
export function parseSettingsNote(search: string): string | null {
  const note = searchParams(search).get("note");
  return note && note.trim() !== "" ? note : null;
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
 *
 * `note` is managed explicitly rather than merely preserved: it is only kept
 * on the `memory` tab, and omitting the argument clears it. That makes "drop
 * the note when you leave Memory" structural instead of something every
 * caller has to remember.
 */
export function formatSettingsSearch(
  tab: SettingsTabId,
  currentSearch = "",
  note: string | null = null,
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
  if (tab === "memory" && note) {
    params.set("note", note);
  } else {
    params.delete("note");
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}
