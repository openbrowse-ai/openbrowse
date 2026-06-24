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
 * Locate a pending `proposePlan` approval on the **newest** assistant
 * message, if any. Returns `null` when the latest assistant message
 * has no `proposePlan` part in `approval-requested` state — even if
 * an older assistant message in history still does.
 *
 * Why "newest assistant message only" (no fallback to older history):
 *   - The AI SDK's approval flow only considers the LAST message
 *     (`messages.at(-1)`); older `approval-requested` parts that lost
 *     the resume window are stale and will be terminalized by
 *     `healPendingTools` at the next edit/retry/regenerate. The
 *     composer mirrors this contract: only the newest pending
 *     approval is actionable.
 *   - Scanning older history can surface a stale card after the user
 *     has already responded to it (e.g. they declined a previous
 *     proposePlan, the agent revised, and the new message has no
 *     pending approval — but the older declined-but-not-yet-healed
 *     part shouldn't reappear in the composer).
 *
 * Recognizes both AI-SDK part shapes:
 *   - `{ type: "dynamic-tool", toolName: "proposePlan", state: "approval-requested", ... }`
 *   - `{ type: "tool-proposePlan", state: "approval-requested", ... }`
 */
export function findPendingPlanApproval(
  messages: ReadonlyArray<AgentUIMessage>,
): PendingPlanApproval | null {
  // Find the newest assistant message; bail (return null) if there
  // isn't one. We deliberately do NOT fall back to earlier messages.
  let latestAssistant: AgentUIMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      latestAssistant = messages[i];
      break;
    }
  }
  if (!latestAssistant) return null;

  for (const part of latestAssistant.parts) {
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
  return null;
}
