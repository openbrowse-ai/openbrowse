import type { UIMessage } from "ai";
import type { ConcernDimension } from "./completion-check/types";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  parts: SerializedUIPart[];
  createdAt: number;
  /**
   * True for assistant messages that are an auto-compaction summary. The
   * compaction-user message that triggered this summary is the message
   * immediately preceding it (its `parts` contain a `CompactionPart`).
   *
   * Set on the assistant message instead of the user message because the
   * "completed compaction" predicate (used by `filterCompactedMessages`)
   * needs to know the summary is fully written; the assistant message's
   * presence + this flag is the natural signal.
   */
  summary?: boolean;
}

export type SerializedUIPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "file"; mediaType: string; url: string }
  | { type: "source-url"; sourceId: string; url: string; title?: string }
  | { type: "step-start" }
  | CompactionPart
  | CompletionCheckRejectionPart
  | PlanExtensionPart
  | SerializedToolPart;

/**
 * Marker part that lives on a synthetic user message inserted into the chat
 * stream when the conversation is compacted. The next assistant message in
 * the stream carries the summary text (with `summary: true` on the message
 * record).
 *
 * - `auto`: true when triggered by the token threshold; false for manual
 *   `/compact` (follow-up).
 * - `overflow`: true when triggered by a context-overflow API error path.
 * - `tailStartMessageId`: id of the first message in the verbatim tail. The
 *   transport's `filterCompactedMessages` uses this to drop the head from
 *   the model view.
 */
export interface CompactionPart {
  type: "data-compaction";
  data: CompactionData;
}

export interface CompactionData {
  auto: boolean;
  overflow?: boolean;
  tailStartMessageId?: string;
}

/**
 * Surfaces a Plan-mode option-C auto-extension to the user. Emitted by
 * the agent transport's auto-extend hook in `toSDKTool`'s `execute` after
 * the plan is mutated in IDB. Persisted as a `user`-role message with
 * this single part, so it renders inline in the conversation stream and
 * survives reloads (parallel to `data-compaction`).
 *
 * Two flavors:
 *   - `kind: "site"` — a new origin was appended to `plan.sites` because
 *     the user just approved an off-plan tab call.
 *   - `kind: "network"` — `plan.allowNetwork` was flipped from false to
 *     true because the user just approved an executePython network call.
 *
 * Stripped before reaching the LLM (see `rewriteForLLM` in
 * `compacting-transport.ts`) — the model has no use for this and an
 * unsubstituted user message containing only this part would convert to
 * an empty `user` model message and fail SDK validation.
 */
export interface PlanExtensionData {
  kind: "site" | "network";
  /** Present when `kind === "site"`. The origin appended to plan.sites. */
  origin?: string;
  extendedAt: number;
}

export interface PlanExtensionPart {
  type: "data-plan-extension";
  data: PlanExtensionData;
}

/**
 * Marker part inserted when the completion-check evaluator rejects the
 * executor's drafted final response. The next executor turn is driven by
 * this concern list (the transport substitutes the part with structured
 * completion-check feedback text before sending to the model). The UI
 * renders it as a distinct comment block so users can see why the loop
 * continued.
 *
 * `rejectionRound` is 1-indexed and useful both for UI ordering and for
 * detecting when we're approaching the max-rounds cap.
 *
 * `concerns` is duplicated from the underlying `EvaluatorVerdict` so the
 * UI doesn't need to look up a separate verdict store; we keep the part
 * self-contained.
 */
export interface CompletionCheckRejectionPart {
  type: "data-completion-check-rejection";
  data: CompletionCheckRejectionData;
}

export interface CompletionCheckRejectionData {
  rejectionRound: number;
  reasoning: string;
  concerns: {
    dimension: ConcernDimension;
    /**
     * Internal/export-only technical description of the concern.
     * Surfaced in the markdown export and in the synthetic feedback
     * message sent to the agent. NOT shown directly in the inline
     * chat UI.
     */
    detail: string;
    /**
     * User-facing one-sentence summary, in plain observation voice.
     * Surfaced inline in the rejection block. See the `Concern.userSummary`
     * JSDoc in `completion-check/types.ts` for the formatting contract
     * the evaluator must follow.
     */
    userSummary: string;
    evidence?: string;
  }[];
  /**
   * True when this is the final allowed rejection — the next turn is the
   * force-emit case. The UI may render a "force-emitted" badge so users
   * understand the response shipped despite open concerns.
   */
  forceEmittedNext?: boolean;
  /**
   * Why the gate emitted this block. Used by the UI to render the
   * appropriate visual variant:
   *
   *  - undefined / "max-rounds-exceeded": real evaluator concerns the
   *    user should see (red/amber banner, expandable concern list).
   *  - "evaluator-error": the evaluator itself failed to commit a
   *    verdict (model hit step cap without finalizing, network blip,
   *    etc.). The agent's response is unaffected; render as a quiet
   *    gray informational note rather than an alarming error.
   *
   * Always undefined for in-loop rejections that triggered another
   * round; only set on terminal force-emit blocks.
   */
  reason?: "max-rounds-exceeded" | "evaluator-error";
}

/**
 * Live status indicator for an active completion-check evaluator call.
 *
 * Emitted by the rejection loop driver in `compacting-transport.ts` to
 * fill the silent window between "assistant draft finished streaming"
 * and "evaluator produced a verdict." Without this, an evaluator call
 * that takes 5–30s leaves the UI looking stuck — the message is fully
 * visible but the gate is invisibly running.
 *
 * Lifecycle (one stable `id` per gate invocation):
 *  1. Just before `runCompletionCheck` runs: emit
 *     `{ id, phase: "evaluating" }`. The UI renders an inline
 *     "Running quality check…" pill.
 *  2. After the verdict resolves: emit
 *     `{ id, phase: "done", outcome: "approved" | "rejected" | ... }`
 *     using the SAME id so the SDK overwrites the existing part's
 *     data. The UI then renders nothing — done is a terminal hide
 *     for every outcome (rejected/force-emitted are surfaced by the
 *     sibling rejection block; approved/skipped are silent).
 *
 * Multi-round rejection loops emit one running entry per round (each
 * with a fresh id) so the user sees the gate run on each iteration.
 *
 * Skipped turns (trigger heuristic returned `gate: false`) do NOT emit
 * a running entry — the transport pre-checks `shouldGate` before
 * starting the lifecycle so we never flash a pill that immediately
 * vanishes.
 *
 * Persistence: running parts are STRIPPED at serialize time
 * (`useAgentChat.ts` `serializeParts`). They never round-trip to
 * chatDb. The data is purely a live-stream concern.
 */
export interface CompletionCheckRunningData {
  /**
   * UUID generated per gate invocation. Stable across the
   * "evaluating" → "done" transition so the SDK overwrites in place
   * rather than appending a second part.
   */
  id: string;
  /**
   * Current phase of the gate call.
   *  - "evaluating": the LLM call is in flight; UI shows the spinner.
   *  - "done":       a verdict has been produced. UI renders nothing
   *                  (concerns, when present, are surfaced by the
   *                  sibling rejection block; clean approves are silent).
   */
  phase: "evaluating" | "done";
  /**
   * The gate's resolved outcome kind. Set only when `phase === "done"`.
   *
   * The UI ignores this field today — every outcome on `done` renders
   * nothing — but it's preserved on the wire (a) so the rejection-
   * loop tests can assert the transport reports outcomes correctly,
   * and (b) so a future telemetry/diagnostics surface can read it
   * without re-plumbing.
   */
  outcome?: "approved" | "skipped" | "rejected" | "force-emitted";
}

/**
 * Custom `DATA_PARTS` map for our `UIMessage`. Keying `compaction` here
 * registers a `data-compaction` variant on `UIMessagePart<AgentDataParts, ...>`
 * with `data: CompactionData`. This is what lets us narrow on
 * `p.type === "data-compaction"` without any casts.
 *
 * The SDK type machinery generates the variant from this map; if you add a
 * new application-specific data part, add it here and the rest of the
 * codebase will pick it up via `AgentUIMessage`.
 */
export type AgentDataParts = {
  compaction: CompactionData;
  "completion-check-rejection": CompletionCheckRejectionData;
  "completion-check-running": CompletionCheckRunningData;
  "plan-extension": PlanExtensionData;
};

/**
 * The `UIMessage` flavor we use throughout the app. The default `metadata`
 * generic (`unknown`) and tool generic (`UITools`) are kept; only the
 * `DATA_PARTS` slot is narrowed to our `AgentDataParts`.
 *
 * Component code, the chat hook, and the `CompactingChatTransport` all
 * type-check against this so the discriminated union of `parts` includes
 * `{ type: "data-compaction"; data: CompactionData; id?: string }`.
 */
export type AgentUIMessage = UIMessage<unknown, AgentDataParts>;

export interface SerializedToolPart {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}
