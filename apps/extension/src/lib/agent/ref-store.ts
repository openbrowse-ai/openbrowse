import type { TabId } from "./driver";
import type { PageStateSignals } from "./snapshot-capture";

export interface RefEntry {
  backendNodeId: number;
  role: string;
  name: string;
  /**
   * Occurrence index of this element among all elements sharing the same
   * (role, name) within its frame, in document order. Lets re-resolution
   * re-find the SAME logical element from a fresh accessibility tree by
   * (role, name, nth) when the cached backendNodeId goes stale — the
   * mechanism agent-browser uses. Defaults to 0 when unknown.
   */
  nth: number;
  /**
   * Frame the element lives in, when it is not the top frame. Threaded
   * through resolution so a future cross-frame session router can target
   * the right CDP session. `undefined` means the top-level frame.
   */
  frameId?: string;
}

interface TabRefs {
  /**
   * The latest snapshot's refs — the authoritative current view of the tab.
   */
  refs: Map<string, RefEntry>;
  /**
   * Carried-over refs from recent prior snapshots that are NOT in the latest
   * one. With content-stable ref ids, a ref the agent took from a snapshot
   * one or two captures ago still identifies the same logical element; if the
   * element scrolled out of the latest viewport-scoped snapshot we can still
   * resolve it (its backendNodeId may be stale, but action tools re-resolve
   * by re-snapshotting). Bounded to the last RECENT_SNAPSHOT_RETENTION
   * snapshots to avoid unbounded growth and stale-pointer rot.
   */
  carriedRefs: Map<string, RefEntry>;
  previousSnapshot: string | null;
  previousSignals: PageStateSignals | null;
}

/**
 * How many prior snapshots' refs we keep resolvable beyond the latest one.
 * 1 means: the latest snapshot plus the one immediately before it. Keeps the
 * window where a just-taken ref stays valid even if the next snapshot's
 * (e.g. viewport-scoped) tree no longer contains it.
 */
const RECENT_SNAPSHOT_RETENTION = 1;

const refsByTab = new Map<TabId, TabRefs>();

export function setRefs(
  tabId: TabId,
  refs: Map<string, RefEntry>,
  snapshotText: string,
  signals: PageStateSignals,
): void {
  const existing = refsByTab.get(tabId);

  // Merge the previous snapshot's refs into the carry-over pool (bounded):
  // any ref from the immediately-prior `refs` that is NOT superseded by the
  // new snapshot remains resolvable. We only retain one generation back, so
  // we rebuild carriedRefs from the prior `refs` rather than accumulating
  // indefinitely.
  const carriedRefs = new Map<string, RefEntry>();
  if (existing && RECENT_SNAPSHOT_RETENTION > 0) {
    for (const [ref, entry] of existing.refs) {
      if (!refs.has(ref)) carriedRefs.set(ref, entry);
    }
  }

  refsByTab.set(tabId, {
    refs,
    carriedRefs,
    previousSnapshot: snapshotText,
    previousSignals: signals,
  });
}

export function getRef(tabId: TabId, ref: string): RefEntry | undefined {
  const tab = refsByTab.get(tabId);
  if (!tab) return undefined;
  // Latest snapshot wins; fall back to recently-carried refs so a ref from
  // the immediately-prior snapshot still resolves.
  return tab.refs.get(ref) ?? tab.carriedRefs.get(ref);
}

export function getRefsForTab(tabId: TabId): Map<string, RefEntry> | undefined {
  return refsByTab.get(tabId)?.refs;
}

export function getPreviousSnapshot(tabId: TabId): string | null {
  return refsByTab.get(tabId)?.previousSnapshot ?? null;
}

export function getPreviousSignals(tabId: TabId): PageStateSignals | null {
  return refsByTab.get(tabId)?.previousSignals ?? null;
}

export function invalidateRefs(tabId: TabId): void {
  refsByTab.delete(tabId);
}

/**
 * After an in-page action (click/type/key), detect whether the action actually
 * caused a navigation to a different document and, if so, hard-invalidate refs
 * BEFORE the post-action snapshot's merge. Without this, the carry-over pool
 * (see `setRefs`) keeps old-page ref ids resolvable to detached backendNodeIds
 * on the new page — the same leak `navigate.ts` guards against with an explicit
 * `invalidateRefs`. In-page re-renders (same URL) intentionally do NOT
 * invalidate, preserving the content-stable ref carry-over.
 *
 * `previousUrl` is the URL at the last snapshot (`PageStateSignals.url`).
 * Best-effort: a failed tab lookup leaves refs untouched. Returns true when it
 * invalidated.
 */
export async function invalidateRefsIfNavigated(
  driver: { getTab: (tabId: TabId) => Promise<{ url?: string }> },
  tabId: TabId,
  previousUrl: string | undefined,
): Promise<boolean> {
  if (!previousUrl) return false;
  let currentUrl: string | undefined;
  try {
    currentUrl = (await driver.getTab(tabId)).url;
  } catch {
    return false;
  }
  if (!currentUrl || currentUrl === previousUrl) return false;
  invalidateRefs(tabId);
  return true;
}

export function hasRefs(tabId: TabId): boolean {
  const entry = refsByTab.get(tabId);
  return !!entry && entry.refs.size > 0;
}
