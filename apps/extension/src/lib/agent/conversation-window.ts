/**
 * Resolve which Chrome window the agent should operate in for a given
 * conversation.
 *
 * Single source of truth for the answer to "which window is THIS chat
 * working in?" — used by:
 *
 *   - The system-prompt awareness block builder (so the agent sees the
 *     conversation's window's tabs, not whichever window the user
 *     happens to be focused on).
 *   - `listTabs` tool dispatch via `session.targetWindowId`.
 *   - `bindTabByHandle` (so a handle from a stale awareness list can't
 *     accidentally bind a foreign-window tab).
 *   - `navigate` (no-handle path) for new-tab placement.
 *   - The renderer's first-tool bootstrap for `getActiveUserTab`.
 *
 * Resolution chain (each step preserves the agent's intuitive mental
 * model — "this chat stays in its own window"):
 *
 *   1. **Owned tab's window** — if the agent has already opened tabs
 *      in this conversation, those tabs anchor the conversation. New
 *      operations join the same window as the owned tabs even if the
 *      user moved them between windows.
 *   2. **`originWindowId`** — the window the chat was opened in. This
 *      is the load-bearing fix for the parallel-spaces bug: two chats
 *      in two different Chrome windows now stay isolated regardless
 *      of which window is focused.
 *   3. **Space window** — the window currently bound to the
 *      conversation's space (via `Space.windowId`). Covers chats whose
 *      `originWindowId` is unset (e.g. pre-migration rows, or the
 *      window was closed and the space migrated to a new one).
 *   4. **Undefined** — no resolvable window. Callers fall back to the
 *      focused window (legacy behavior), which is the right default
 *      for scheduled runs and tests.
 *
 * Step 1 wins over step 2 so a user who deliberately moves a working
 * tab to another window doesn't trip the resolver into bouncing new
 * tabs back to the original window.
 *
 * Async + chatDb/storage bound. Callers cache the result for the run's
 * lifetime where appropriate (`session.targetWindowId`) so the hot
 * path stays sync.
 */

import { chatDb } from "@/lib/chat-db";
import { storage } from "@/lib/storage";
import { tabRegistry } from "./tab-registry";

export async function resolveConversationWindowId(
  conversationId: string,
): Promise<number | undefined> {
  const conv = await chatDb.getConversation(conversationId);
  if (!conv) return undefined;

  // 1) Prefer the window of an existing owned tab so new tabs join the
  //    conversation's tab group rather than splitting across windows.
  //    Probe in order and take the first live tab. Each `ownedLtids`
  //    entry is a LogicalTabId (string); resolve to a chrome ctid via
  //    the registry before calling chrome.tabs.get.
  for (const ltid of conv.ownedLtids ?? []) {
    const ctid = tabRegistry.toChromeTabId(ltid);
    if (ctid == null) continue;
    try {
      const tab = await chrome.tabs.get(ctid);
      if (typeof tab.windowId === "number") {
        // Verify the window still exists — a closed window leaves zombie
        // tabs briefly in the registry. Cheap and defensive.
        try {
          await chrome.windows.get(tab.windowId);
          return tab.windowId;
        } catch {
          // Window gone; fall through.
        }
      }
    } catch {
      // Tab gone; try the next owned id.
    }
  }

  // 2) Fall back to the originWindowId stamped at conversation create
  //    time. This is what fixes the cross-window leak: when the user
  //    has two chats in two different windows, each chat carries its
  //    own origin so the tab queries scope correctly even when the
  //    user focuses the OTHER window.
  if (typeof conv.originWindowId === "number") {
    try {
      await chrome.windows.get(conv.originWindowId);
      return conv.originWindowId;
    } catch {
      // Origin window was closed; fall through.
    }
  }

  // 3) Conversation's space window. Covers chats whose originWindowId
  //    is unset (pre-migration rows, or origin window was closed and
  //    the user moved the space to a new window).
  //
  //    Lazy self-heal: `space.windowId` can be null even though the
  //    space's anchored home tab is alive in a live window (e.g. the
  //    `chrome.windows.onRemoved` listener nulled the binding when the
  //    window closed, but the user then re-opened the space's home tab
  //    in a fresh window — and `reconcileSpacesWithWindows`, which
  //    re-binds via anchor URLs, only runs at extension boot). Without
  //    this heal, every agent run in such a space falls through to
  //    `undefined` and `chrome.tabs.create` defaults to the focused
  //    window, leaking the agent's tabs across spaces.
  //
  //    On a null (or stale) binding we search live windows for one
  //    whose tabs include the space's home anchor URL
  //    (`?space=<spaceId>`). If found, we persist the binding back to
  //    storage (so future reads skip the search) and return that
  //    windowId.
  if (conv.spaceId) {
    const targetSpaceId = conv.spaceId;
    try {
      const spaces = await storage.getSpaces();
      const space = spaces.find((s) => s.id === targetSpaceId);
      if (space) {
        const windowId = space.windowId;
        if (typeof windowId === "number") {
          try {
            await chrome.windows.get(windowId);
            return windowId;
          } catch {
            // Space's stored windowId points at a dead window; fall
            // through to heal.
          }
        }
        // Heal: scan live windows for the space's home anchor.
        try {
          const wins = await chrome.windows.getAll({ populate: true });
          const anchorMarker = `?space=${targetSpaceId}`;
          const match = wins.find((w) =>
            w.tabs?.some((t) => t.url && t.url.includes(anchorMarker)),
          );
          if (match && typeof match.id === "number") {
            // Persist so subsequent resolves are fast and idempotent.
            try {
              const fresh = spaces.map((s) =>
                s.id === targetSpaceId ? { ...s, windowId: match.id! } : s,
              );
              await storage.setSpaces(fresh);
            } catch {
              // best-effort; the in-memory return value is still
              // correct for this call.
            }
            return match.id;
          }
        } catch {
          // Window query failed (e.g. SW transient). The lazy heal will
          // retry on the next resolver call; undefined return below
          // lets the caller's focused-window fallback apply for now.
        }
      }
    } catch {
      // storage unavailable; fall through.
    }
  }

  // 4) No resolvable window — caller falls back to the focused window.
  return undefined;
}
