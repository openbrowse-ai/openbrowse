/**
 * Wait-for-persistence handshake for the background site-skill curator.
 *
 * The curator-enqueue runs inside `onCompletionCheckApproved`, which the
 * transport invokes *before* the stream closes. The turn's assistant message —
 * the one carrying the full, untruncated `executeOnPage` tool parts the curator
 * needs — is persisted to chat-db by the stream consumer *after* the callback
 * fires (same JS context). So the enqueue must wait for the assistant message
 * to land before reading `chatDb.getMessages(cid)`.
 *
 * We subscribe to chat-db's in-process message-change pubsub and resolve the
 * moment the persisted count exceeds the pre-turn baseline, with a timeout
 * fallback so a missed/coalesced event can't hang the fire-and-forget path.
 *
 * Extracted as a pure, dependency-injected helper so the handshake is unit
 * testable without standing up the whole transport.
 */

export interface PersistWaitDeps {
  /** Current persisted message count for the conversation. */
  getMessageCount: (conversationId: string) => Promise<number>;
  /**
   * Subscribe to message-table mutations. The listener receives the
   * conversationId of the affected conversation. Returns an unsubscribe fn.
   */
  subscribeMessageChange: (
    listener: (conversationId: string) => void,
  ) => () => void;
}

/**
 * Resolve once chat-db has more messages than `baselineCount` for `cid`, or
 * after `timeoutMs`. Returns the message count observed at resolution.
 */
export async function waitForAssistantPersist(
  deps: PersistWaitDeps,
  cid: string,
  baselineCount: number,
  timeoutMs = 5000,
): Promise<number> {
  // Fast path: the message may already be persisted (e.g. a missed-event race
  // where persistence beat us to the callback).
  const current = await deps.getMessageCount(cid);
  if (current > baselineCount) return current;

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (count: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(count);
    };
    const unsubscribe = deps.subscribeMessageChange((changedCid) => {
      if (changedCid !== cid) return;
      void deps.getMessageCount(cid).then((count) => {
        if (count > baselineCount) finish(count);
      });
    });
    const timer = setTimeout(() => {
      void deps.getMessageCount(cid).then(finish);
    }, timeoutMs);
  });
}
