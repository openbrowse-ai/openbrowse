import type { AgentUIMessage } from "@/lib/agent/message-types";

/**
 * Pending proposePlan approval surfaced from the live message stream.
 * Returned by {@link findPendingPlanApproval} for the chat composer to
 * mount {@link PlanApprovalCard} in place of {@link ChatInput}.
 */
export interface PendingPlanApproval {
  toolCallId: string;
  approvalId: string;
  /**
   * The proposePlan call's parsed input, as the SDK has emitted it so far.
   * The card defends against partial input internally (`?? []` / `?? ""`)
   * so streaming-incomplete shapes are safe to pass through.
   */
  input: Record<string, unknown>;
}

/**
 * True when `value` is a plain object — not null, not an array, not a
 * primitive. Used by {@link findPendingPlanApproval} to guard against
 * malformed `input` payloads (the SDK types `input` as `unknown`, and
 * a stray array or null would otherwise reach consumers expecting an
 * object — `sites.map(...)` etc.).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/**
 * Locate the latest assistant message's pending `proposePlan` approval, if
 * any. Returns `null` when no message has a `proposePlan` part in
 * `approval-requested` state.
 *
 * Why "latest assistant message" rather than scanning everything:
 *   - The SDK only allows one pending approval at a time on a single
 *     message; older messages with approval-requested parts are stale
 *     (the SDK heals them out).
 *   - With Plan-mode's `activeTools: ["proposePlan"]` restriction
 *     (see prepareCall in agent-transport), the only approval-requested
 *     part on a fresh Plan-mode turn is `proposePlan` — but other tools'
 *     approval-requested parts may live on prior assistant messages
 *     (e.g. an executeOnPage gate the user already responded to). We
 *     scan for the LATEST proposePlan match across all assistant
 *     messages so that a stale older message can't shadow a newer one,
 *     but practically the latest assistant message dominates.
 *
 * Recognizes both AI-SDK part shapes:
 *   - `{ type: "dynamic-tool", toolName: "proposePlan", state: "approval-requested", ... }`
 *   - `{ type: "tool-proposePlan", state: "approval-requested", ... }`
 */
export function findPendingPlanApproval(
  messages: ReadonlyArray<AgentUIMessage>,
): PendingPlanApproval | null {
  // Iterate newest-to-oldest so the first match is the latest.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      const p = part as {
        type?: string;
        toolName?: string;
        state?: string;
        toolCallId?: string;
        input?: unknown;
        approval?: { id?: string };
      };
      if (p.state !== "approval-requested") continue;
      const isProposePlan =
        (p.type === "dynamic-tool" && p.toolName === "proposePlan") ||
        p.type === "tool-proposePlan";
      if (!isProposePlan) continue;
      if (typeof p.toolCallId !== "string") continue;
      if (!p.approval || typeof p.approval.id !== "string") continue;
      return {
        toolCallId: p.toolCallId,
        approvalId: p.approval.id,
        input: isPlainObject(p.input) ? p.input : {},
      };
    }
  }
  return null;
}
