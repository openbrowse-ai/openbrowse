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

/**
 * Whether `conversationId` is safe to embed in a storage key.
 *
 * Conversation ids are minted by `crypto.randomUUID()`, but the active
 * conversation id can also originate from attacker-influenceable sources
 * (e.g. `window.location.hash` / URL params). Restricting to an
 * allowlist of url-safe characters with a length cap means a crafted id
 * (e.g. `__proto__`) can never become the computed property name written
 * to storage — closing the remote-property-injection vector flagged by
 * CodeQL. (The `KEY_PREFIX` already neutralizes prototype pollution, but
 * this makes the key provably sanitized.)
 */
function isSafeConversationId(conversationId: string): boolean {
  return (
    typeof conversationId === "string" &&
    conversationId.length > 0 &&
    conversationId.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(conversationId)
  );
}

function key(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}`;
}

/** Mark a newly-created conversation as needing its first turn dispatched. */
export async function markPendingFirstTurn(
  conversationId: string,
): Promise<void> {
  if (!isSafeConversationId(conversationId)) return;
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
  if (!isSafeConversationId(conversationId)) return false;
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
  if (!isSafeConversationId(conversationId)) return;
  try {
    await chrome.storage?.session?.remove?.(key(conversationId));
  } catch {
    /* ignore */
  }
}
