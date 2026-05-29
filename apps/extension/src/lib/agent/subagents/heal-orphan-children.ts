/**
 * Heal-time reconciliation for orphaned subagent runs.
 *
 * When the parent chat agent's stream is interrupted before its
 * `delegate` tool call returns (network error, MV3 service-worker
 * pause, browser reload, etc.), three rows end up out of sync:
 *
 *   1. Parent assistant message: dynamic-tool part stuck in
 *      `input-available` state. Healed to `output-error` by
 *      `healPendingTools` in useAgentChat — that part is *not* this
 *      file's concern.
 *
 *   2. Child Conversation row: `subagentStatus: "running"` because
 *      the runner died before reaching `finalizeChildConversation`.
 *      THIS file fixes that.
 *
 *   3. Ephemeral incognito window (if isolation === "incognito"):
 *      cleaned up by the background SW startup pass which already
 *      coordinates with the same heal path.
 *
 * Two callsites use this helper:
 *
 *   - `useAgentChat.persistHealedMessages` (after healing a parent
 *     stream's stranded tool calls).
 *
 *   - `background/index.ts` startup pass (blanket sweep — any
 *     `subagentStatus: "running"` row at SW boot is by definition
 *     orphaned).
 *
 * Idempotent: only finalizes when the row's current `subagentStatus`
 * is still `"running"`.
 */

import { chatDb } from "../../chat-db";
import { finalizeChildConversation } from "./child-conversation";

export interface HealedDelegatePart {
  /**
   * `delegate` tool call id whose parent stream was interrupted.
   * Used to look up the corresponding child Conversation row via
   * `findChildByParentToolCallId`.
   */
  toolCallId: string;
}

/**
 * Heal-side: finalize child conversations whose parent `delegate`
 * tool calls were just healed. Children created before v12 (no
 * `parentToolCallId` stamp) are skipped here and picked up by the
 * SW startup blanket sweep instead.
 */
export async function finalizeOrphanedChildrenForHeals(args: {
  parentConversationId: string;
  healedDelegateToolCallIds: string[];
  /**
   * Custom message persisted as the child's final text. Defaults to a
   * generic "interrupted" string. Override at the SW startup callsite
   * to mention "extension reloaded" specifically.
   */
  finalText?: string;
}): Promise<void> {
  const { parentConversationId, healedDelegateToolCallIds } = args;
  const finalText =
    args.finalText ??
    "(interrupted: parent stream ended before subagent finished)";

  for (const toolCallId of healedDelegateToolCallIds) {
    try {
      const child = await chatDb.findChildByParentToolCallId(
        parentConversationId,
        toolCallId,
      );
      if (!child) continue;
      if (child.subagentStatus !== "running") continue;
      await finalizeChildConversation({
        childConversationId: child.id,
        status: "failed",
        finalText,
      });
    } catch (err) {
      // Best-effort. Log and continue so one bad row doesn't block the rest.
      console.warn(
        "[subagents] finalize orphaned child failed:",
        toolCallId,
        err,
      );
    }
  }
}

/**
 * SW-startup-side: blanket reconciliation. Any `subagentStatus:
 * "running"` row at SW boot is necessarily orphaned (the runner
 * only writes "running" while alive in memory). Finalize them all.
 *
 * Returns the conversation ids that were finalized so the caller can
 * follow up with side effects (closing ephemeral incognito windows,
 * etc.).
 */
export async function finalizeAllRunningChildrenAtStartup(args?: {
  finalText?: string;
}): Promise<string[]> {
  const finalText =
    args?.finalText ??
    "(interrupted: extension reloaded before subagent finished)";

  const all = await chatDb.listConversations();
  const orphans = all.filter((c) => c.subagentStatus === "running");
  const finalized: string[] = [];
  for (const conv of orphans) {
    try {
      await finalizeChildConversation({
        childConversationId: conv.id,
        status: "failed",
        finalText,
      });
      finalized.push(conv.id);
    } catch (err) {
      console.warn(
        "[subagents] startup orphan finalize failed:",
        conv.id,
        err,
      );
    }
  }
  return finalized;
}
