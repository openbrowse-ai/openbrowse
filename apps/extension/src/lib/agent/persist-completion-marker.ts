import { chatDb } from "../chat-db";
import type { GateOutcome } from "./completion-check/types";

/**
 * Persist the agent-tab-cleanup completion marker. Only an `approved`
 * outcome marks the conversation as complete (force-emitted / skipped /
 * rejected do not). Best-effort: a failed write is swallowed so a
 * telemetry-style failure can't block the user's response.
 */
export async function persistCompletionMarker(
  conversationId: string,
  outcomeKind: GateOutcome["kind"],
  now: number,
): Promise<void> {
  if (outcomeKind !== "approved") return;
  try {
    const conv = await chatDb.getConversation(conversationId);
    if (!conv) return;
    await chatDb.updateConversation(conversationId, {
      lastCompletionApproved: true,
      taskCompletedAt: now,
    });
  } catch {
    // Best-effort; never block the response on marker persistence.
  }
}
