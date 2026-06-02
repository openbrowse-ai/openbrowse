/**
 * Idempotent reopen for the `OVERLAY_UNDO` `action: "reopen"` flow used by
 * agent tab-cleanup. Each close mints a unique `id` on its undo payload
 * (see `CloseTabsUndo` in tab-scoping.ts). The client can send the same
 * `OVERLAY_UNDO` more than once (e.g. a click-undo racing a ⌘Z, or message
 * replay); the background reopen handler is NOT naturally idempotent
 * (`chrome.tabs.create` per tab would duplicate tabs). This module dedupes
 * by remembering consumed undo ids so a repeated reopen is a no-op.
 */

export interface ReopenUndo {
  action: "reopen";
  /** Stable unique id for this close, minted at close time. */
  id?: string;
  tabs: { url: string; windowId: number; pinned: boolean }[];
}

/**
 * Reopen the tabs in `undo` exactly once per undo id. Returns the number of
 * tabs reopened (0 if this id was already consumed or there's nothing to do).
 *
 * `consumed` is the caller-owned set of already-applied undo ids (an
 * in-memory Set in the background service worker). Payloads without an `id`
 * (older/foreign shapes) are always applied — they predate idempotency and
 * have no dedup key.
 */
export async function reopenTabsOnce(
  undo: ReopenUndo,
  consumed: Set<string>,
): Promise<number> {
  const tabs = undo.tabs ?? [];
  if (tabs.length === 0) return 0;

  if (undo.id != null) {
    if (consumed.has(undo.id)) return 0;
    // Mark consumed BEFORE awaiting any create so a second invocation that
    // arrives while the first is still in flight also short-circuits.
    consumed.add(undo.id);
  }

  let reopened = 0;
  for (const t of tabs) {
    await chrome.tabs.create({ url: t.url, windowId: t.windowId, pinned: t.pinned });
    reopened++;
  }
  return reopened;
}
