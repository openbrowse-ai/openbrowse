/**
 * Enforces the physical tab-strip ordering invariant:
 *
 *   pinned tabs → favorite tabs → regular tabs
 *
 * Chrome already keeps pinned tabs at the front of the strip natively, so
 * the only boundary we police here is favorite-vs-regular: every favorite
 * tab must sit before every non-pinned, non-favorite ("regular") tab.
 *
 * "Favorite" is not a native Chrome tab property — a tab is a favorite when
 * its URL is saved in the space's `favorites` list OR it is currently
 * associated with a favorite (see `favorite-tabs.ts`). This module reuses
 * that classification so the strip order matches what the overlay's tab
 * list renders (Pinned → Favorites → Active).
 *
 * Enforcement is reactive: a `chrome.tabs.onMoved` listener validates each
 * move and, if it breaks the invariant, moves the offending tab back to a
 * valid slot ("bounce back"). Manual drags in Chrome's tab strip and the
 * in-app drag-reorder both funnel through the same check.
 */

import { storage } from "@/lib/storage";
import {
  ensureAdoptedForWindow,
  getAssociatedTabIds,
  getAssociations,
} from "./favorite-tabs";
import type { Space } from "@/lib/types";

type TabClass = "pinned" | "favorite" | "regular";

/**
 * Re-entrancy guard. Our corrective `chrome.tabs.move` re-fires
 * `onMoved`; we tag the windows we're actively correcting so the listener
 * ignores the echo instead of fighting itself. This is a boolean flag
 * scoped to the duration of our own move — distinct from `windowLocks`,
 * which serializes whole operations.
 */
const correctingWindows = new Set<number>();

/**
 * Per-window serialization. `enforceTabOrder` / `positionFavoriteTab`
 * each do async reads (classify the strip) before issuing a
 * `chrome.tabs.move`; two concurrent external moves in the same window
 * could otherwise both pass the echo guard, read stale state, and issue
 * conflicting moves. We chain all work for a given window onto a single
 * promise so only one operation runs at a time per window (other windows
 * stay parallel).
 */
const windowLocks = new Map<number, Promise<void>>();

/**
 * Debounce timers for persisting favorite order per window. `onMoved` fires
 * once per index hop *during* a drag, so persisting on every event would
 * write transient mid-drag orders (and corrupt the saved `position` values
 * the bounce relies on). We instead wait until the drag settles — no further
 * `onMoved` for `FAVORITE_PERSIST_DEBOUNCE_MS` — then persist the final order.
 */
const favoritePersistTimers = new Map<number, ReturnType<typeof setTimeout>>();
const FAVORITE_PERSIST_DEBOUNCE_MS = 300;

function scheduleFavoriteOrderPersist(windowId: number): void {
  const existing = favoritePersistTimers.get(windowId);
  if (existing) clearTimeout(existing);
  favoritePersistTimers.set(
    windowId,
    setTimeout(() => {
      favoritePersistTimers.delete(windowId);
      void persistFavoriteOrderForWindow(windowId);
    }, FAVORITE_PERSIST_DEBOUNCE_MS),
  );
}

function withWindowLock(
  windowId: number,
  fn: () => Promise<void>,
): Promise<void> {
  const prior = windowLocks.get(windowId) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  // Keep the chain alive only while this op is the tail; clean up once
  // settled so the map doesn't grow unbounded.
  windowLocks.set(windowId, next);
  void next.finally(() => {
    if (windowLocks.get(windowId) === next) {
      windowLocks.delete(windowId);
    }
  });
  return next;
}

async function classifyWindowTabs(windowId: number): Promise<{
  tabs: chrome.tabs.Tab[];
  classOf: Map<number, TabClass>;
  space: Space | undefined;
  /** Saved `position` of the favorite each adopted (favorite) tab represents. */
  favoritePositionOf: Map<number, number>;
}> {
  const tabs = await chrome.tabs.query({ windowId });
  tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const space = await storage.getSpaceByWindowId(windowId);
  // A tab is a "favorite" iff it is the live tab currently adopted by a
  // favorite (the association is the source of truth — Arc-style hostname
  // adoption, see favorite-tabs.ts). We intentionally do NOT classify by
  // raw URL match: only the *adopted* tab counts, so a second tab on the
  // same favorite host stays "regular".
  const associatedIds = space ? getAssociatedTabIds(space.id) : new Set<number>();

  // tabId -> saved favorite position, so a violating favorite can be
  // bounced back to its rank-correct slot (not just the end of the block).
  const favoritePositionOf = new Map<number, number>();
  if (space) {
    const positionByUrl = new Map(space.favorites.map((f) => [f.url, f.position]));
    for (const a of getAssociations(space.id)) {
      const pos = positionByUrl.get(a.favoriteUrl);
      if (pos != null) favoritePositionOf.set(a.tabId, pos);
    }
  }

  const classOf = new Map<number, TabClass>();
  for (const t of tabs) {
    if (t.id == null) continue;
    if (t.pinned) {
      classOf.set(t.id, "pinned");
    } else if (associatedIds.has(t.id)) {
      classOf.set(t.id, "favorite");
    } else {
      classOf.set(t.id, "regular");
    }
  }
  return { tabs, classOf, space, favoritePositionOf };
}

const RANK: Record<TabClass, number> = { pinned: 0, favorite: 1, regular: 2 };

/**
 * Compute the index a tab should be moved to so the strip satisfies
 * pinned → favorite → regular, or `null` if the current order is already
 * valid. Only inspects the favorite/regular boundary; pinned ordering is
 * Chrome's responsibility.
 */
function computeCorrectIndex(
  tabs: chrome.tabs.Tab[],
  classOf: Map<number, TabClass>,
  movedTabId: number,
  favoritePositionOf: Map<number, number>,
): number | null {
  const movedClass = classOf.get(movedTabId);
  if (movedClass == null || movedClass === "pinned") return null;

  const movedIndex = tabs.findIndex((t) => t.id === movedTabId);
  if (movedIndex === -1) return null;

  // A move is valid iff, scanning the strip, class ranks never decrease.
  // For the moved tab specifically: no later tab may have a smaller rank,
  // and no earlier tab may have a larger rank.
  let violation = false;
  for (let i = 0; i < tabs.length; i++) {
    const id = tabs[i].id;
    if (id == null || id === movedTabId) continue;
    const cls = classOf.get(id);
    if (cls == null || cls === "pinned") continue;
    if (i < movedIndex && RANK[cls] > RANK[movedClass]) {
      violation = true; // a regular sits before this favorite
      break;
    }
    if (i > movedIndex && RANK[cls] < RANK[movedClass]) {
      violation = true; // a favorite sits after this regular
      break;
    }
  }
  if (!violation) return null;

  const pinnedCount = tabs.filter((t) => t.id != null && classOf.get(t.id) === "pinned").length;
  const favoriteCount = tabs.filter((t) => t.id != null && classOf.get(t.id) === "favorite").length;

  if (movedClass === "favorite") {
    // Restore the favorite to its rank-correct slot within the favorites
    // block, ordered by each favorite's saved `position` — so dragging a
    // favorite out past others returns it to where it belongs, not the end.
    const movedPos = favoritePositionOf.get(movedTabId) ?? Number.MAX_SAFE_INTEGER;
    let rank = 0;
    for (const t of tabs) {
      if (t.id == null || t.id === movedTabId) continue;
      if (classOf.get(t.id) !== "favorite") continue;
      const pos = favoritePositionOf.get(t.id) ?? Number.MAX_SAFE_INTEGER;
      if (pos < movedPos) rank++;
    }
    return pinnedCount + rank;
  }
  // regular: place at the start of the regulars block.
  return pinnedCount + favoriteCount;
}

/**
 * Validate the position of `movedTabId` in its window and bounce it back
 * to a valid slot if it violates pinned → favorite → regular. No-op if the
 * order is already valid. Safe to call from both the `onMoved` listener and
 * the in-app reorder handler.
 */
export async function enforceTabOrder(
  windowId: number,
  movedTabId: number,
): Promise<void> {
  // Skip the self-triggered echo of our own corrective move.
  if (correctingWindows.has(windowId)) return;
  return withWindowLock(windowId, async () => {
    // Re-check inside the lock: a queued op may have started a correction
    // (and set the echo flag) while we were waiting our turn.
    if (correctingWindows.has(windowId)) return;
    try {
      // Make sure favorites in this window are adopted (and the map is
      // hydrated) before classifying — otherwise a not-yet-adopted favorite
      // would be seen as "regular" and the guard would miss it.
      await ensureAdoptedForWindow(windowId);
      const { tabs, classOf, space, favoritePositionOf } =
        await classifyWindowTabs(windowId);
      const correctIndex = computeCorrectIndex(
        tabs,
        classOf,
        movedTabId,
        favoritePositionOf,
      );
      if (correctIndex == null) {
        // Valid order. If the user reordered favorites *within* the zone,
        // persist the new order so it sticks (and survives SW restart,
        // since adoption reads the saved order). Debounced until the drag
        // settles — onMoved fires per hop mid-drag, and persisting a
        // transient order would corrupt the saved positions the bounce
        // relies on.
        if (space && classOf.get(movedTabId) === "favorite") {
          scheduleFavoriteOrderPersist(windowId);
        }
        return;
      }
      // A violating drop is about to be bounced — cancel any pending
      // settle-persist so it can't write the transient (violating) order.
      const pending = favoritePersistTimers.get(windowId);
      if (pending) {
        clearTimeout(pending);
        favoritePersistTimers.delete(windowId);
      }
      correctingWindows.add(windowId);
      try {
        // chrome.tabs.move throws "Tabs cannot be edited right now (user
        // may be dragging a tab)" while the drag is still in progress —
        // and onMoved fires DURING the drag, so the bounce must wait for
        // the drag to finish. Retry the corrective move until the strip is
        // editable, re-validating each time.
        await moveTabWhenEditable(windowId, movedTabId);
      } finally {
        correctingWindows.delete(windowId);
      }
    } catch {
      correctingWindows.delete(windowId);
      // Tab/window gone, or move raced; ignore.
    }
  });
}

/**
 * Bounce `movedTabId` to its correct slot, retrying while the user is still
 * dragging (Chrome rejects `chrome.tabs.move` mid-drag). Re-classifies on
 * each attempt so the target stays correct as the strip settles. Gives up
 * after a bounded number of attempts.
 */
async function moveTabWhenEditable(
  windowId: number,
  movedTabId: number,
): Promise<void> {
  const MAX_ATTEMPTS = 15;
  const DELAY_MS = 120;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { tabs, classOf, favoritePositionOf } =
      await classifyWindowTabs(windowId);
    const correctIndex = computeCorrectIndex(
      tabs,
      classOf,
      movedTabId,
      favoritePositionOf,
    );
    if (correctIndex == null) return; // already valid (drag settled in place)
    try {
      await chrome.tabs.move(movedTabId, { index: correctIndex });
      return; // success
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // Only retry the "user is dragging" case; rethrow anything else.
      if (!/drag/i.test(msg) && !/cannot be edited/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
}

/**
 * Rewrite `space.favorites` so the open (adopted) favorites follow the
 * current physical strip order. Closed favorites (no live tab) keep their
 * prior relative order and are appended after the open ones. Only writes
 * when the order actually changed, to avoid redundant storage churn.
 */
async function persistFavoriteOrder(
  space: Space,
  tabs: chrome.tabs.Tab[],
  classOf: Map<number, TabClass>,
): Promise<void> {
  // favorite tabId -> favoriteUrl (via associations)
  const urlByTab = new Map<number, string>();
  for (const a of getAssociations(space.id)) urlByTab.set(a.tabId, a.favoriteUrl);

  // Open favorite URLs in physical strip order.
  const openOrder: string[] = [];
  const seen = new Set<string>();
  for (const t of tabs) {
    if (t.id == null || classOf.get(t.id) !== "favorite") continue;
    const url = urlByTab.get(t.id);
    if (url && !seen.has(url)) {
      openOrder.push(url);
      seen.add(url);
    }
  }
  if (openOrder.length === 0) return;

  // Closed favorites (not currently open), preserving their prior order.
  const closed = space.favorites.filter((f) => !seen.has(f.url));
  const newFavs = [
    ...openOrder.map((url) => space.favorites.find((f) => f.url === url)!),
    ...closed,
  ].filter(Boolean);

  // No-op if order is unchanged.
  const sameOrder =
    newFavs.length === space.favorites.length &&
    newFavs.every((f, i) => f.url === space.favorites[i].url);
  if (sameOrder) return;

  newFavs.forEach((f, i) => {
    f.position = i;
  });
  await storage.updateSpace(space.id, { favorites: newFavs });
}

/**
 * Debounced target: re-classify the window once the drag has settled and
 * persist the final favorite order. Runs under the window lock so it can't
 * race a concurrent enforce/position op, and skips persisting if the strip
 * isn't in a valid order (shouldn't happen post-settle, but be safe).
 */
async function persistFavoriteOrderForWindow(windowId: number): Promise<void> {
  return withWindowLock(windowId, async () => {
    if (correctingWindows.has(windowId)) return;
    try {
      const { tabs, classOf, space, favoritePositionOf } =
        await classifyWindowTabs(windowId);
      if (!space) return;
      // Don't persist a transient/violating order. Validate every favorite
      // tab is in a non-violating position before writing.
      for (const t of tabs) {
        if (t.id == null || classOf.get(t.id) !== "favorite") continue;
        if (computeCorrectIndex(tabs, classOf, t.id, favoritePositionOf) != null) {
          return;
        }
      }
      await persistFavoriteOrder(space, tabs, classOf);
    } catch {
      // window/tab gone; ignore.
    }
  });
}

/**
 * Move a freshly-favorited tab into the favorites zone so the strip order
 * reflects its new status immediately (rather than only after a manual
 * drag). Places it at the end of the favorites block, just before the
 * first regular tab.
 */
export async function positionFavoriteTab(
  windowId: number,
  tabId: number,
): Promise<void> {
  if (correctingWindows.has(windowId)) return;
  return withWindowLock(windowId, async () => {
    if (correctingWindows.has(windowId)) return;
    try {
      await ensureAdoptedForWindow(windowId);
      const tabs = await chrome.tabs.query({ windowId });
      tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const pinnedCount = tabs.filter((t) => t.pinned).length;

      const space = await storage.getSpaceByWindowId(windowId);
      const associatedIds = space
        ? getAssociatedTabIds(space.id)
        : new Set<number>();

      // Count favorites (adopted tabs) excluding the one we're positioning.
      const favoriteCount = tabs.filter(
        (t) =>
          t.id != null &&
          t.id !== tabId &&
          !t.pinned &&
          associatedIds.has(t.id),
      ).length;

      const target = pinnedCount + favoriteCount;
      correctingWindows.add(windowId);
      try {
        await chrome.tabs.move(tabId, { index: target });
      } finally {
        correctingWindows.delete(windowId);
      }
    } catch {
      correctingWindows.delete(windowId);
    }
  });
}
