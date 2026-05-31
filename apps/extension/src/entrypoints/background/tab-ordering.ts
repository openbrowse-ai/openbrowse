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
import { getAssociatedTabIds } from "./favorite-tabs";

type TabClass = "pinned" | "favorite" | "regular";

/**
 * Re-entrancy guard. Our corrective `chrome.tabs.move` re-fires
 * `onMoved`; we tag the windows we're actively correcting so the listener
 * ignores the echo instead of fighting itself.
 */
const correctingWindows = new Set<number>();

async function classifyWindowTabs(
  windowId: number,
): Promise<{ tabs: chrome.tabs.Tab[]; classOf: Map<number, TabClass> }> {
  const tabs = await chrome.tabs.query({ windowId });
  tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const space = await storage.getSpaceByWindowId(windowId);
  const favoriteUrls = new Set((space?.favorites ?? []).map((f) => f.url));
  const associatedIds = space ? getAssociatedTabIds(space.id) : new Set<number>();

  const classOf = new Map<number, TabClass>();
  for (const t of tabs) {
    if (t.id == null) continue;
    if (t.pinned) {
      classOf.set(t.id, "pinned");
    } else if (
      (t.url != null && favoriteUrls.has(t.url)) ||
      associatedIds.has(t.id)
    ) {
      classOf.set(t.id, "favorite");
    } else {
      classOf.set(t.id, "regular");
    }
  }
  return { tabs, classOf };
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

  // Bounce target: the boundary index for the moved tab's class among
  // non-pinned tabs. Favorites go right after the last pinned tab; regulars
  // go right after the last favorite.
  const pinnedCount = tabs.filter((t) => t.id != null && classOf.get(t.id) === "pinned").length;
  const favoriteCount = tabs.filter((t) => t.id != null && classOf.get(t.id) === "favorite").length;

  if (movedClass === "favorite") {
    // Place at the end of the favorites block (just before regulars).
    // Index accounts for the moved tab being removed from its current slot.
    const target = pinnedCount + favoriteCount - 1;
    return Math.max(pinnedCount, target);
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
  if (correctingWindows.has(windowId)) return;
  try {
    const { tabs, classOf } = await classifyWindowTabs(windowId);
    const correctIndex = computeCorrectIndex(tabs, classOf, movedTabId);
    if (correctIndex == null) return;
    correctingWindows.add(windowId);
    try {
      await chrome.tabs.move(movedTabId, { index: correctIndex });
    } finally {
      correctingWindows.delete(windowId);
    }
  } catch {
    correctingWindows.delete(windowId);
    // Tab/window gone, or move raced; ignore.
  }
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
  try {
    const tabs = await chrome.tabs.query({ windowId });
    tabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const pinnedCount = tabs.filter((t) => t.pinned).length;

    const space = await storage.getSpaceByWindowId(windowId);
    const favoriteUrls = new Set((space?.favorites ?? []).map((f) => f.url));
    const associatedIds = space
      ? getAssociatedTabIds(space.id)
      : new Set<number>();

    // Count favorites excluding the one we're positioning.
    const favoriteCount = tabs.filter(
      (t) =>
        t.id != null &&
        t.id !== tabId &&
        !t.pinned &&
        ((t.url != null && favoriteUrls.has(t.url)) || associatedIds.has(t.id)),
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
}
