import type { FavoriteTab, FavoriteTabAssociation, Space } from "@/lib/types";

/**
 * Runtime link between a saved favorite (a `FavoriteTab`, persisted in the
 * space) and the live Chrome tab currently "acting as" that favorite.
 *
 * Identity is by **hostname**, Arc-style: a favorite is adopted by a tab
 * whose URL is a path-prefix subset of the favorite URL, and stays adopted
 * across navigation as long as the tab remains on the same hostname.
 *
 * The in-memory `associations` map is the fast path, but it lives in the
 * MV3 service worker and is wiped on eviction. We write through to
 * `chrome.storage.session` (survives SW eviction, clears on browser
 * restart — exactly the lifetime of a Chrome tab id) so the favorite ↔ tab
 * link survives the routine ~30s idle eviction. On cold start we hydrate
 * the map back from session storage before any classification runs.
 */

const associations = new Map<string, Map<string, FavoriteTabAssociation>>();

const SESSION_KEY = "favoriteAssociations";

// ---------------------------------------------------------------------------
// URL matching helpers
// ---------------------------------------------------------------------------

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

/**
 * Adoption test: `tabUrl` is a path-prefix subset of `favUrl` when they
 * share a hostname AND the favorite's path is a prefix of the tab's path.
 * So favorite `https://github.com` adopts `https://github.com/login`, and
 * favorite `https://github.com/a/b` adopts `.../a/b/issues` but not
 * `https://github.com/other`.
 */
export function isPrefixSubset(tabUrl: string, favUrl: string): boolean {
  const th = hostnameOf(tabUrl);
  const fh = hostnameOf(favUrl);
  if (th == null || fh == null || th !== fh) return false;
  const favPath = pathOf(favUrl).replace(/\/$/, "");
  if (favPath === "" || favPath === "/") return true;
  const tabPath = pathOf(tabUrl);
  return tabPath === favPath || tabPath.startsWith(favPath + "/");
}

/** Retain test: same hostname, regardless of path/query/hash. */
export function sameHostname(tabUrl: string, favUrl: string): boolean {
  const th = hostnameOf(tabUrl);
  const fh = hostnameOf(favUrl);
  return th != null && fh != null && th === fh;
}

/**
 * When several favorites in a space could adopt a tab, prefer the one with
 * the longest matching path prefix; break ties by `position`. Returns the
 * best favorite or null.
 */
function bestFavoriteFor(
  tabUrl: string,
  favorites: FavoriteTab[],
): FavoriteTab | null {
  let best: FavoriteTab | null = null;
  let bestLen = -1;
  for (const fav of favorites) {
    if (!isPrefixSubset(tabUrl, fav.url)) continue;
    const len = pathOf(fav.url).replace(/\/$/, "").length;
    if (len > bestLen || (len === bestLen && best != null && fav.position < best.position)) {
      best = fav;
      bestLen = len;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Persistence (chrome.storage.session)
// ---------------------------------------------------------------------------

/** Flatten the nested map to a plain object for session storage. */
function serialize(): Record<string, FavoriteTabAssociation[]> {
  const out: Record<string, FavoriteTabAssociation[]> = {};
  for (const [spaceId, map] of associations) {
    out[spaceId] = [...map.values()];
  }
  return out;
}

function persist(): void {
  try {
    void chrome.storage.session.set({ [SESSION_KEY]: serialize() });
  } catch {
    // session storage unavailable; in-memory map still works for this SW life.
  }
}

let hydratePromise: Promise<void> | null = null;

/**
 * Repopulate the in-memory map from session storage. Idempotent — the
 * first call kicks off hydration and every later call shares the same
 * promise, so concurrent callers (e.g. the ordering guard on a cold SW
 * wake) all wait for the same one-time load.
 */
export function hydrate(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      const data = stored[SESSION_KEY] as
        | Record<string, FavoriteTabAssociation[]>
        | undefined;
      if (!data) return;
      for (const [spaceId, list] of Object.entries(data)) {
        const map = getSpaceMap(spaceId);
        for (const assoc of list) map.set(assoc.favoriteUrl, assoc);
      }
    } catch {
      // ignore; map stays empty and bootstrap will re-adopt.
    }
  })();
  return hydratePromise;
}

/** Await one-time hydration of the association map. */
export function ensureHydrated(): Promise<void> {
  return hydrate();
}

// ---------------------------------------------------------------------------
// Core map operations
// ---------------------------------------------------------------------------

function getSpaceMap(spaceId: string): Map<string, FavoriteTabAssociation> {
  let map = associations.get(spaceId);
  if (!map) {
    map = new Map();
    associations.set(spaceId, map);
  }
  return map;
}

export function associate(
  spaceId: string,
  favoriteUrl: string,
  tabId: number,
  currentUrl: string,
  currentTitle: string,
  currentFavicon: string,
) {
  getSpaceMap(spaceId).set(favoriteUrl, {
    favoriteUrl,
    tabId,
    currentUrl,
    currentTitle,
    currentFavicon,
  });
  persist();
}

export function disassociateByTab(tabId: number) {
  for (const map of associations.values()) {
    for (const [url, assoc] of map) {
      if (assoc.tabId === tabId) {
        map.delete(url);
        persist();
        return;
      }
    }
  }
}

export function disassociateByFavorite(spaceId: string, favoriteUrl: string) {
  if (associations.get(spaceId)?.delete(favoriteUrl)) persist();
}

export function getAssociations(spaceId: string): FavoriteTabAssociation[] {
  return [...(associations.get(spaceId)?.values() ?? [])];
}

export function getAssociatedTabIds(spaceId: string): Set<number> {
  const map = associations.get(spaceId);
  if (!map) return new Set();
  return new Set([...map.values()].map((a) => a.tabId));
}

export function updateTabInfo(
  tabId: number,
  url?: string,
  title?: string,
  favicon?: string,
) {
  for (const map of associations.values()) {
    for (const assoc of map.values()) {
      if (assoc.tabId === tabId) {
        if (url !== undefined) assoc.currentUrl = url;
        if (title !== undefined) assoc.currentTitle = title;
        if (favicon !== undefined) assoc.currentFavicon = favicon;
        persist();
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Adoption / retention (Arc-style hostname model)
// ---------------------------------------------------------------------------

/** The favoriteUrl a given tab is currently associated with, if any. */
function findAssocByTab(
  tabId: number,
): { spaceId: string; assoc: FavoriteTabAssociation } | null {
  for (const [spaceId, map] of associations) {
    for (const assoc of map.values()) {
      if (assoc.tabId === tabId) return { spaceId, assoc };
    }
  }
  return null;
}

/**
 * React to a tab's URL changing. Handles the three transitions:
 *  - associated tab stays on the same hostname → just refresh currentUrl;
 *  - associated tab left the hostname → drop it and try to re-adopt the
 *    favorite from another open same-hostname tab;
 *  - unassociated tab whose URL is a prefix-subset of an un-adopted
 *    favorite → adopt it (the first such tab wins).
 */
export async function reconcileTabUrl(
  space: Space,
  tabId: number,
  url: string,
  title?: string,
  favicon?: string,
): Promise<boolean> {
  const existing = findAssocByTab(tabId);
  if (existing) {
    if (sameHostname(url, existing.assoc.favoriteUrl)) {
      updateTabInfo(tabId, url, title, favicon);
      return false;
    }
    // Left the hostname — no longer this favorite.
    const favoriteUrl = existing.assoc.favoriteUrl;
    disassociateByFavorite(existing.spaceId, favoriteUrl);
    await readoptFavorite(space, favoriteUrl, tabId);
    // The tab itself may now be a prefix-subset of a *different* favorite.
    maybeAdopt(space, tabId, url, title, favicon);
    return true;
  }
  return maybeAdopt(space, tabId, url, title, favicon);
}

/**
 * Adopt `tabId` for the best-matching favorite that currently has no live
 * association. Returns true if an association was created.
 */
export function maybeAdopt(
  space: Space,
  tabId: number,
  url: string,
  title?: string,
  favicon?: string,
): boolean {
  const fav = bestFavoriteFor(url, space.favorites);
  if (!fav) return false;
  const map = associations.get(space.id);
  if (map?.has(fav.url)) return false; // already adopted by some tab
  associate(space.id, fav.url, tabId, url, title ?? fav.title, favicon ?? fav.favicon);
  return true;
}

/**
 * After an adopted tab is lost (closed or navigated away), try to re-adopt
 * `favoriteUrl` from another currently-open same-hostname tab in the
 * window (Q-B: re-adopt rather than just going inactive). `excludeTabId`
 * skips the tab that just lost the association.
 */
export async function readoptFavorite(
  space: Space,
  favoriteUrl: string,
  excludeTabId?: number,
): Promise<void> {
  if (!space.windowId) return;
  const fav = space.favorites.find((f) => f.url === favoriteUrl);
  if (!fav) return;
  if (associations.get(space.id)?.has(favoriteUrl)) return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ windowId: space.windowId });
  } catch {
    return;
  }
  tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const t of tabs) {
    if (t.id == null || t.id === excludeTabId || t.pinned) continue;
    if (t.url && isPrefixSubset(t.url, favoriteUrl)) {
      // Don't steal a tab already adopted by another favorite.
      if (findAssocByTab(t.id)) continue;
      associate(
        space.id,
        favoriteUrl,
        t.id,
        t.url,
        t.title ?? fav.title,
        t.favIconUrl ?? fav.favicon,
      );
      return;
    }
  }
}

/**
 * Called when a tab is removed. If it was an adopted favorite, drop it and
 * re-adopt the favorite from another open same-hostname tab if possible.
 */
export async function handleTabRemoved(
  spaces: Space[],
  tabId: number,
): Promise<void> {
  const existing = findAssocByTab(tabId);
  if (!existing) return;
  const favoriteUrl = existing.assoc.favoriteUrl;
  disassociateByTab(tabId);
  const space = spaces.find((s) => s.id === existing.spaceId);
  if (space) await readoptFavorite(space, favoriteUrl, tabId);
}

// ---------------------------------------------------------------------------
// Startup bootstrap / on-demand reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile + adopt for a single space against its window's current tabs:
 *  - drop associations whose tab is gone or wandered off the hostname;
 *  - refresh live info for retained ones;
 *  - adopt the first prefix-subset tab for any still-unassociated favorite.
 * Honors "one adopted tab per favorite" via `maybeAdopt`.
 */
async function adoptForSpace(space: Space): Promise<void> {
  if (!space.windowId || space.favorites.length === 0) return;
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({ windowId: space.windowId });
  } catch {
    return;
  }
  const liveIds = new Set(
    tabs.map((t) => t.id).filter((id): id is number => id != null),
  );
  const map = getSpaceMap(space.id);

  for (const [favUrl, assoc] of [...map]) {
    const tab = tabs.find((t) => t.id === assoc.tabId);
    if (!tab || !liveIds.has(assoc.tabId) || (tab.url && !sameHostname(tab.url, favUrl))) {
      map.delete(favUrl);
    } else if (tab.url) {
      assoc.currentUrl = tab.url;
      assoc.currentTitle = tab.title ?? assoc.currentTitle;
      assoc.currentFavicon = tab.favIconUrl ?? assoc.currentFavicon;
    }
  }

  tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const t of tabs) {
    if (t.id == null || t.pinned || !t.url) continue;
    if (findAssocByTab(t.id)) continue;
    maybeAdopt(space, t.id, t.url, t.title, t.favIconUrl);
  }
  persist();
}

/**
 * Ensure favorites in `windowId`'s space are adopted before code that reads
 * the association map (e.g. the tab-ordering guard) runs. Awaits hydration
 * first so a cold service-worker wake can't race an empty map, then runs a
 * cheap adoption pass (no `chrome.tabs.move`, so it won't trigger onMoved).
 */
export async function ensureAdoptedForWindow(windowId: number): Promise<void> {
  await ensureHydrated();
  try {
    const { storage } = await import("@/lib/storage");
    const space = await storage.getSpaceByWindowId(windowId);
    if (space) await adoptForSpace(space);
  } catch {
    // ignore; classification will fall back to whatever is in the map.
  }
}

export async function bootstrap(spaces: Space[]) {
  await hydrate();
  for (const space of spaces) {
    await adoptForSpace(space);
  }
}
