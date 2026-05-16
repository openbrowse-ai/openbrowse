/**
 * Shortcuts: learn (query → URL) selections so frequently-picked URLs for a
 * given query rise to the top on subsequent searches.
 *
 * Storage: chrome.storage.local under key `_overlayShortcuts`.
 *
 * Shape:
 *   {
 *     [canonicalUrl]: {
 *       hits: number,            // total selections of this URL
 *       lastUsedAt: number,      // ms
 *       title?: string,          // last-known title (display fallback)
 *       url: string,             // last-known full URL
 *       queries: { [normalizedQuery: string]: { hits: number, lastUsedAt: number } }
 *     }
 *   }
 *
 * Bounded LRU: max ~500 entries, pruned by lastUsedAt asc when over capacity.
 */
import { canonicalUrl } from "./canonical";

const STORAGE_KEY = "_overlayShortcuts";
const MAX_ENTRIES = 500;
const MAX_QUERIES_PER_ENTRY = 16;

export interface ShortcutQuery {
  hits: number;
  lastUsedAt: number;
}

export interface ShortcutEntry {
  hits: number;
  lastUsedAt: number;
  title?: string;
  url: string;
  queries: { [normalizedQuery: string]: ShortcutQuery };
}

export type ShortcutStore = { [canonicalUrl: string]: ShortcutEntry };

/** Cached in-memory copy. Loaded on first `loadShortcuts()` call. */
let cache: ShortcutStore | null = null;
let loadPromise: Promise<ShortcutStore> | null = null;

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

export async function loadShortcuts(): Promise<ShortcutStore> {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const data = await chrome.storage.local.get(STORAGE_KEY);
      cache = (data[STORAGE_KEY] as ShortcutStore) ?? {};
    } catch {
      cache = {};
    }
    return cache;
  })();
  return loadPromise;
}

/** Synchronous accessor; returns {} if not yet loaded. */
export function getCachedShortcuts(): ShortcutStore {
  return cache ?? {};
}

/** Record that the user selected `url` (with `title`) after typing `query`. */
export async function recordShortcutSelection(query: string, url: string, title?: string): Promise<void> {
  const q = normalizeQuery(query);
  if (!q) return;
  const key = canonicalUrl(url);
  if (!key) return;

  const store = await loadShortcuts();
  const now = Date.now();
  const existing = store[key];
  const queries = existing?.queries ?? {};
  const existingQ = queries[q];
  queries[q] = {
    hits: (existingQ?.hits ?? 0) + 1,
    lastUsedAt: now,
  };

  // Cap per-entry queries (LRU on lastUsedAt)
  const qKeys = Object.keys(queries);
  if (qKeys.length > MAX_QUERIES_PER_ENTRY) {
    const sorted = qKeys
      .map((k) => [k, queries[k].lastUsedAt] as const)
      .sort((a, b) => a[1] - b[1]);
    const toDelete = sorted.slice(0, qKeys.length - MAX_QUERIES_PER_ENTRY);
    for (const [k] of toDelete) delete queries[k];
  }

  store[key] = {
    hits: (existing?.hits ?? 0) + 1,
    lastUsedAt: now,
    title: title ?? existing?.title,
    url,
    queries,
  };

  // Cap total entries (LRU on lastUsedAt)
  const allKeys = Object.keys(store);
  if (allKeys.length > MAX_ENTRIES) {
    const sorted = allKeys
      .map((k) => [k, store[k].lastUsedAt] as const)
      .sort((a, b) => a[1] - b[1]);
    const toDelete = sorted.slice(0, allKeys.length - MAX_ENTRIES);
    for (const [k] of toDelete) delete store[k];
  }

  cache = store;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  } catch {
    // best-effort write
  }
}

/**
 * Compute a boost for a candidate URL given the current query.
 *
 * Looks for any prior recorded query that the current `q` starts with (i.e.
 * the user has typed past, or exactly equal to, what they typed before),
 * and returns a non-negative boost roughly scaled by hit count and recency.
 *
 * Requires recorded queries to be at least 2 characters so a single typed
 * character doesn't promote every URL the user ever picked.
 *
 * Returns 0 if no shortcut applies.
 */
export function shortcutBoost(currentQuery: string, url: string): number {
  const q = normalizeQuery(currentQuery);
  if (!q) return 0;
  const store = getCachedShortcuts();
  const entry = store[canonicalUrl(url)];
  if (!entry) return 0;

  let bestHits = 0;
  let bestRecency = 0;
  for (const [recordedQ, info] of Object.entries(entry.queries)) {
    if (recordedQ.length < 2) continue;
    if (!q.startsWith(recordedQ)) continue;
    if (info.hits > bestHits) {
      bestHits = info.hits;
      bestRecency = info.lastUsedAt;
    }
  }

  if (bestHits === 0) return 0;
  const ageDays = Math.max((Date.now() - bestRecency) / (1000 * 60 * 60 * 24), 0.1);
  const recencyFactor = 1 / (1 + Math.log10(1 + ageDays));
  return Math.log(1 + bestHits) * 200 * recencyFactor;
}

/** Returns true if the URL has a recorded prefix-shortcut for the query. */
export function isShortcutFor(currentQuery: string, url: string): boolean {
  return shortcutBoost(currentQuery, url) > 0;
}
