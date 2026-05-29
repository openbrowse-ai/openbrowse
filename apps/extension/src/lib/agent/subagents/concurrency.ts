/**
 * Per-parent concurrency tracking for subagent runs.
 *
 * The cap is enforced at `delegate.execute` time. When a subagent finishes
 * (success, failure, cancel), the runner's `finally` block must call
 * `releaseSubagentSlot` to keep the counter accurate across MV3 service
 * worker pauses.
 *
 * State is module-local (in-memory). On extension reload, counts reset to
 * zero — runaway subagents from a crashed worker cannot persist.
 */

/** Maximum concurrent subagents per parent conversation. */
export const MAX_SUBAGENTS_PER_PARENT = 10;

/** Map from parent conversation id → active subagent count. */
const counts = new Map<string, number>();

export function activeSubagentCount(parentConversationId: string): number {
  return counts.get(parentConversationId) ?? 0;
}

/**
 * Reserve a slot for a new subagent run. Throws if the parent already has
 * `MAX_SUBAGENTS_PER_PARENT` active subagents.
 */
export function acquireSubagentSlot(parentConversationId: string): void {
  const current = counts.get(parentConversationId) ?? 0;
  if (current >= MAX_SUBAGENTS_PER_PARENT) {
    throw new Error(
      `Subagent concurrency cap reached for parent ${parentConversationId} ` +
        `(${MAX_SUBAGENTS_PER_PARENT} active). Wait for one to finish, or ` +
        `combine related work into a single subagent task.`,
    );
  }
  counts.set(parentConversationId, current + 1);
}

export function releaseSubagentSlot(parentConversationId: string): void {
  const current = counts.get(parentConversationId) ?? 0;
  if (current <= 1) {
    counts.delete(parentConversationId);
    return;
  }
  counts.set(parentConversationId, current - 1);
}

/** @internal Tests only. */
export function resetSubagentSlotsForTesting(): void {
  counts.clear();
}
