/**
 * Types for the verify-gated completion ("Completion check") system.
 *
 * The completion-check pattern intercepts the executor agent's final
 * response and runs a separate skeptical evaluator pass before letting
 * the response reach the user. If the evaluator finds problems, it
 * returns concerns partitioned by dimension; the harness then re-injects
 * those concerns as a synthetic completion-check turn so the executor
 * can address them.
 *
 * Design notes:
 *  - Always-on. There is no `enabled` toggle. To match the convention
 *    of comparable agents (Manus, Comet, Devin) the check fires on
 *    every gateable turn. The only user-facing configuration is the
 *    evaluator model.
 *  - The verdict shape carries optional `scores`/`trend` fields reserved
 *    for a future scored-mode (Phase 7 in the rollout plan). They are
 *    unused today but live on the type so adding them later is
 *    non-breaking.
 *  - Concerns are dimension-tagged so the executor's rejection feedback
 *    can be partitioned ("completeness: ..." vs "evidenceGrounding:
 *    ...") rather than a single opaque rejection string. This is the
 *    "binary verdict + structured concerns" hybrid chosen over pure
 *    binary or full numeric scoring; see the SOTA research synthesis
 *    for rationale.
 */

/**
 * Dimensions an evaluator may flag a concern against.
 *
 * Keep this list small and orthogonal. Adding a new dimension is a real
 * change: the evaluator prompt, settings UI, telemetry store, and
 * rejection feedback formatter all key off this enum.
 */
export type ConcernDimension =
  /**
   * The drafted response doesn't fulfill the original user request
   * end-to-end. Examples: claimed "top 3" but listed 2; promised a
   * comparison but only described one item.
   */
  | "completeness"
  /**
   * Todo state contradicts the claimed completion. Pending or in-progress
   * todos still exist that should have been closed (or explicitly
   * cancelled) before the executor declared done.
   */
  | "planClosure"
  /**
   * A factual claim in the drafted response (price, count, page content,
   * URL, etc.) is not supported by any tool observation produced this turn.
   * The executor either invented the fact or carried it from stale context.
   */
  | "evidenceGrounding"
  /**
   * The response punts work back to the user that was within the original
   * scope. Phrases like "you can now do X yourself" when X was the asked-for
   * outcome.
   */
  | "noPrematureHandoff"
  /**
   * The response describes the page state but the evaluator's own snapshot
   * disagrees. Only populated when the evaluator chose to ground via
   * read-only tool calls.
   */
  | "surfaceAccuracy";

/**
 * A single concern raised by the evaluator. Each rejection verdict typically
 * contains 1–4 concerns; if there are no concerns, the verdict is approve.
 */
export interface Concern {
  dimension: ConcernDimension;
  /**
   * Specific, actionable description of the problem in evaluator
   * voice. Used internally for two purposes:
   *
   * 1. The synthetic "completion-check feedback" message sent back to
   *    the executor agent for the next loop iteration. The agent
   *    needs the precise technical framing here to ground its
   *    revision (cite text, name elements, point at evidence).
   * 2. The markdown export's audit trail (full technical detail).
   *
   * NOT shown directly in the inline chat UI — see {@link userSummary}
   * for the user-facing rewrite.
   *
   * Bad:  "incomplete"
   * Good: "Drafted response says 'top 3 results' but only lists 2 items."
   */
  detail: string;
  /**
   * User-facing one-sentence summary of the concern, in plain
   * observation voice. Surfaced inline in the chat UI under the
   * "Refining answer" / "This response may have issues" pill.
   *
   * Hard requirements (enforced via the evaluator's structured-output
   * schema and reinforced in the system prompt):
   *  - Observation voice. NOT addressed to "the agent". The user
   *    reading their chat doesn't see the agent as a separate party;
   *    third-person evaluator-to-agent framing breaks the illusion.
   *  - No prescriptive verbs ("should", "needs to", "must"). Frame as
   *    observations, not commands.
   *  - No internal jargon: don't surface dimension names
   *    ("completeness", "evidenceGrounding"), tool names, snapshot
   *    references, etc.
   *  - One sentence per concern. Soft cap ~25 words. Hard cap 180
   *    chars (Zod-enforced).
   *
   * Bad:  "The agent needs to verify the cafe's hours."
   * Good: "Hours might be inaccurate — site shows 7am–8pm weekends, not 7pm."
   */
  userSummary: string;
  /**
   * Optional supporting quote: a snippet of the drafted response, a tool
   * output excerpt, or a snapshot reference (`@e3`) the evaluator inspected
   * while raising the concern. Helps the executor target the fix and helps
   * humans audit the evaluator's judgment via telemetry.
   *
   * NOT surfaced in the inline UI; flows through to the markdown export
   * and the synthetic feedback message.
   */
  evidence?: string;
}

/**
 * The structured verdict returned by the evaluator LLM call.
 *
 * `decision` is binary in the current implementation. The `scores`/`trend`
 * fields are reserved for the (potentially never-shipped) scored mode and
 * ignored by the rest of the system today.
 */
export interface EvaluatorVerdict {
  decision: "approve" | "reject";
  /**
   * Empty array when `decision === "approve"`. One entry per distinct issue
   * when `decision === "reject"`; multiple concerns may share a dimension
   * if they're independently actionable.
   */
  concerns: Concern[];
  /**
   * Plain-language one-paragraph summary of the verdict. Shown to the user
   * in the completion-check UI block on rejection so they can see what
   * caught the evaluator's eye even before the executor responds.
   */
  reasoning: string;
  /**
   * Self-reported confidence on `[0, 1]`. Used for telemetry.
   */
  confidence: number;

  // ---- Reserved for future scored mode; unpopulated today. ----

  /**
   * Per-dimension numeric scores when in scored mode. Each dimension may
   * carry its own threshold so the verdict's `decision` is a deterministic
   * function of `score >= threshold` for all populated dimensions.
   */
  scores?: Partial<
    Record<ConcernDimension, { score: number; threshold: number }>
  >;
  /**
   * Cross-iteration trend if the evaluator was given prior verdicts. Drives
   * the future "refine vs pivot vs ship" decision.
   */
  trend?: "improving" | "stable" | "degrading";
}

/**
 * Outcome returned by the gate orchestrator. Distinct from
 * `EvaluatorVerdict` because the gate may decide to skip evaluation
 * entirely (the trigger heuristic returned false), in which case there
 * is no verdict to report.
 */
export type GateOutcome =
  | {
      kind: "skipped";
      reason: "trigger-not-met" | "no-final-text" | "pending-tool-calls";
    }
  | { kind: "approved"; verdict: EvaluatorVerdict }
  | { kind: "rejected"; verdict: EvaluatorVerdict; rejectionRound: number }
  | {
      kind: "force-emitted";
      verdict: EvaluatorVerdict;
      rejectionRound: number;
      reason: "max-rounds-exceeded" | "evaluator-error";
    };

/**
 * User-facing settings for the completion-check feature. Lives at
 * `Settings.completionCheck` so it can be persisted alongside other
 * agent configuration.
 *
 * Single field: `evaluatorModel`. The check itself is always on — there
 * is no enable/disable toggle. The trigger heuristic and rejection
 * budget are hardcoded internal constants in `index.ts`.
 *
 *  - undefined  → use executor model with fresh context (default;
 *                 matches Anthropic Mar 2026 same-model-fresh-context
 *                 recommendation)
 *  - "<provider>:<modelId>" → run the evaluator on the specified
 *                 model (e.g. a cheaper model than the executor for
 *                 cost optimization; PayZen 2026 reports 59% of
 *                 production agents use 2+ models)
 */
export interface CompletionCheckSettings {
  evaluatorModel?: string;
}

/**
 * Hard cap on rejection rounds before the gate force-emits with a
 * warning. Hardcoded constant (not a user-facing setting). Matches the
 * convergent default across the 2026 production literature: Anthropic
 * Mar 2026 evaluator-error fallback, Hopwood Dec 2025 production
 * recommendation, and PayZen 2026 production-survey median.
 */
export const MAX_REJECTION_ROUNDS = 3;

/**
 * Why the gate skipped, when it did. The three states correspond to the
 * three early-exits in `shouldGate`:
 *  - "no-final-text": tool-only step; no draft to evaluate yet.
 *  - "pending-tool-calls": at least one tool call ended the iteration in
 *    `state: "pending"` — its input was emitted but no output/error/denial
 *    chunk arrived before the stream closed. The most common cause is
 *    a tool that requires human approval: the SDK pauses the iteration
 *    after `tool-input-available` + `tool-approval-request` and never
 *    emits `tool-output-available` until the user clicks Allow. The
 *    drafted text at that point is mid-task ("I'll now run X to do Y")
 *    and shouldn't be evaluated as a final response. The gate fires on
 *    the next iteration (after approval) when the tool actually has
 *    output.
 *  - "trigger-not-met": trivial Q&A turn (no todos, no tool calls).
 */
export type SkipReason =
  | "trigger-not-met"
  | "no-final-text"
  | "pending-tool-calls";

/**
 * One entry in the trace of tool calls the executor made during the
 * turn under review. Captured live by `observeChunkForCompletionCheck`
 * and handed to the evaluator so it can see *what the executor saw*,
 * not just *what the executor did*.
 *
 * The output capture is the single biggest input to evaluator quality:
 * without it, the evaluator must re-call tools to verify any claim,
 * which burns the per-eval research budget. With it, the evaluator can
 * judge most claims from context alone.
 *
 * `state` distinguishes:
 *  - "completed":  tool ran and returned an output (output captured in
 *                  `outputSummary`, hard-truncated)
 *  - "errored":    tool ran but returned an error (`outputSummary`
 *                  contains the error text, hard-truncated)
 *  - "denied":     tool was approval-gated and the user denied it
 *                  (`outputSummary` is null)
 *  - "pending":    input was emitted but no output/error/denial chunk
 *                  arrived before the stream closed (orphaned call;
 *                  `outputSummary` is null)
 *
 * Outputs are JSON.stringified and hard-truncated per call to
 * `TRACE_OUTPUT_TRUNCATE_CHARS` to keep prompt size predictable. The
 * snapshot/readPage/extract tools can produce 10–50KB of payload; we
 * deliberately drop the tail rather than implementing a smarter budget.
 */
export interface ToolCallTraceEntry {
  /** Tool name (e.g. "snapshot", "extract"). */
  name: string;
  /**
   * Stringified input arguments, hard-truncated. Mirrors the
   * pre-Phase-6 `summary` field — kept under the new name for clarity
   * now that we also capture outputs.
   */
  inputSummary: string;
  /**
   * Stringified tool output (or error text), hard-truncated. `null`
   * when the tool was denied or the call was orphaned at stream close.
   */
  outputSummary: string | null;
  /** Terminal lifecycle state of the call by the time the stream ended. */
  state: "completed" | "errored" | "denied" | "pending";
}

/**
 * Hard char cap applied to each `inputSummary` and `outputSummary` in
 * the tool-call trace. Truncation is suffix-based ("… (truncated)") so
 * the evaluator can tell when content was cut. Inputs use a smaller
 * budget than outputs because input args are typically short while
 * outputs (snapshots, page text) can be huge.
 */
export const TRACE_INPUT_TRUNCATE_CHARS = 200;
export const TRACE_OUTPUT_TRUNCATE_CHARS = 800;
