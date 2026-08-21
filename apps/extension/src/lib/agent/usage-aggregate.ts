/**
 * Read-time aggregation of conversation usage.
 *
 * ## The two token numbers, and why they differ
 *
 * `ConversationUsage` carries two easily-conflated quantities, and they answer
 * different questions:
 *
 *  - **`inputTokens`** — how much of the context window the latest request
 *    actually occupied. This is the honest "how full is the context" number,
 *    and the one the UI should display.
 *
 *  - **`totalTokens`** (`inputTokens + outputTokens`) — a projection of the
 *    NEXT request's prompt, because this step's output becomes part of it.
 *    That makes it the right input to the compaction trigger, which compares
 *    against `contextWindow - maxOutput - buffer` (see `shouldCompact`).
 *
 * Using `totalTokens` for display is what forced `usagePercentValue` to clamp
 * at 100% — output tokens are counted against an input-only ceiling, so the
 * ratio could legitimately exceed 1. Displaying `inputTokens` removes the
 * cause rather than the symptom.
 *
 * ## Why cost is summed at read time
 *
 * Subagent runs accumulate `costUsd` on their OWN child conversation rows
 * (see `recordUsageForStep` wiring in `agent-transport.ts`). Summing children
 * here, at read time, keeps the roll-up idempotent: the heal paths
 * (`finalizeOrphanedChildrenForHeals`, `finalizeAllRunningChildrenAtStartup`)
 * can finalize the same child more than once, which a write-time roll-up into
 * the parent's `costUsd` could not survive without an extra "already counted"
 * marker on the row. It also means a still-running subagent's spend is
 * visible immediately instead of only at finalize.
 *
 * One level of children is exhaustive: `delegate` enforces depth = 1, so a
 * subagent cannot spawn subagents of its own.
 */

import { chatDb } from "../chat-db";
import type { ConversationUsage } from "../types";

/**
 * Sum of `costUsd` across every subagent child of `parentConversationId`.
 * Returns 0 when the conversation has no children or the lookup fails —
 * cost display must never break the header indicator.
 */
export async function sumSubagentCostUsd(
  parentConversationId: string,
): Promise<number> {
  try {
    const children = await chatDb.listChildren(parentConversationId);
    return children.reduce((sum, c) => sum + (c.usage?.costUsd ?? 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Context-window occupancy of the latest request, in tokens.
 *
 * Prefer this over `usage.totalTokens` for anything user-facing: it's what
 * the model actually received, so it's directly comparable to
 * `usage.contextWindow`.
 */
export function occupiedTokens(usage: ConversationUsage): number {
  return usage.inputTokens;
}

/**
 * Projected size of the NEXT request's prompt, in tokens — the quantity the
 * compaction trigger reasons about. Exported for symmetry with
 * {@link occupiedTokens} so callers name which of the two they mean instead
 * of reaching for `totalTokens` and inheriting whichever meaning the reader
 * assumes.
 */
export function projectedNextPromptTokens(usage: ConversationUsage): number {
  return usage.totalTokens;
}
