/**
 * "Pending first turn" marker for newly-created conversations.
 *
 * When a conversation is created from a submit path (the side panel /
 * ChatView `handleSubmit` new-conversation branch, or the home
 * LandingPage), the first user message is persisted to chat-db and the
 * UI switches to the new conversation via `onNewConversation`. The first
 * agent turn is then dispatched by the message-load effect once the new
 * conversation mounts.
 *
 * Historically that dispatch rode on the message-load auto-resume branch.
 * Auto-resume was removed (it caused every open tab to restart the same
 * task), so we need an explicit, scoped signal that says "this freshly
 * created conversation still needs its first turn kicked off" — WITHOUT
 * re-enabling auto-resume for stale tabs reopening existing conversations.
 *
 * The marker lives in `chrome.storage.session` (shared across extension
 * contexts at the origin) so it survives the home LandingPage → side
 * panel hand-off. It is consumed (read) by the load effect and cleared
 * once the first turn is dispatched. Cross-tab double-dispatch is
 * prevented by the run-ownership claim, not by this marker, so the marker
 * does not need to be atomic.
 */

const KEY_PREFIX = "pending-first-turn:";

function key(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}`;
}

/** Mark a newly-created conversation as needing its first turn dispatched. */
export async function markPendingFirstTurn(
  conversationId: string,
): Promise<void> {
  try {
    await chrome.storage?.session?.set?.({ [key(conversationId)]: Date.now() });
  } catch {
    /* session storage unavailable (non-extension/test context); ignore */
  }
}

/** True if this conversation is still awaiting its first-turn dispatch. */
export async function hasPendingFirstTurn(
  conversationId: string,
): Promise<boolean> {
  try {
    const k = key(conversationId);
    const r = await chrome.storage?.session?.get?.(k);
    return Boolean(r && r[k]);
  } catch {
    return false;
  }
}

/** Clear the marker once the first turn has been dispatched (or abandoned). */
export async function clearPendingFirstTurn(
  conversationId: string,
): Promise<void> {
  try {
    await chrome.storage?.session?.remove?.(key(conversationId));
  } catch {
    /* ignore */
  }
}
