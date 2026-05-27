/**
 * Completion-check gate orchestration.
 *
 * The gate sits between the executor agent's drafted final response and
 * the user. For each candidate response, the gate decides:
 *
 *  1. Whether to evaluate at all ({@link shouldGate}).
 *  2. If yes, runs the evaluator and produces a verdict.
 *  3. Records telemetry on the outcome regardless of decision.
 *
 * What the orchestrator does NOT do (lives in the transport):
 *  - Pause/resume the executor loop on rejection
 *  - Inject synthetic reviewer-feedback turns
 *  - Manage the rejection-round counter across loop iterations
 *
 * The orchestrator's job is "given a candidate response, produce a
 * verdict and record telemetry."
 */

import type { LanguageModel, ToolSet } from "ai";
import type { TodoItem } from "../../types";
import { runEvaluator } from "./evaluator";
import { completionCheckTelemetry } from "./telemetry";
import {
  MAX_REJECTION_ROUNDS,
  type EvaluatorVerdict,
  type GateOutcome,
  type SkipReason,
  type ToolCallTraceEntry,
} from "./types";

// Re-export for the few consumers that imported these types directly
// from the orchestrator module under the old `goal-contract` name.
export type { SkipReason, CompletionCheckSettings } from "./types";

/**
 * Pure decision: should the gate evaluate this candidate response?
 *
 * Encapsulated as a separate function so the trigger heuristic can be
 * unit-tested without spinning up an evaluator. Mirrors the structure of
 * `shouldCompact` in `compaction.ts`.
 *
 * The trigger fires when ALL of the following hold:
 *  - There is non-empty final text (otherwise the model only produced
 *    tool calls; nothing to evaluate yet).
 *  - The turn was non-trivial: either the conversation has todos
 *    (planned multi-step task) OR the executor made tool calls this
 *    turn (acted on the world). Pure Q&A turns with no tools and no
 *    plan skip the gate cheaply.
 *
 * @returns `{ gate: true }` if the gate should run; `{ gate: false, reason }`
 *          otherwise so callers can pass the reason through to telemetry.
 */
export function shouldGate(
  candidate: {
    /** Final assistant text, after stream completes. */
    finalText: string;
    /** Conversation's current todo list. */
    todos: TodoItem[];
    /** Tool calls produced by the executor in this turn. */
    toolCallTrace: ToolCallTraceEntry[];
  },
): { gate: true } | { gate: false; reason: SkipReason } {
  if (!candidate.finalText.trim()) {
    return { gate: false, reason: "no-final-text" };
  }

  // Non-trivial turn heuristic: either the agent planned (todos) or
  // acted (tool calls). Trivial Q&A turns get skipped to save cost.
  const hasTodos = candidate.todos.length > 0;
  const hasToolCalls = candidate.toolCallTrace.length > 0;
  if (!hasTodos && !hasToolCalls) {
    return { gate: false, reason: "trigger-not-met" };
  }

  return { gate: true };
}

export interface RunCompletionCheckInput {
  conversationId: string;
  /** 0-indexed turn ordinal in the conversation. */
  turnIndex: number;
  /**
   * 0-indexed rejection round within the current turn. 0 = first
   * verdict; 1+ = subsequent rounds after rejection.
   */
  rejectionRound: number;
  /** The original user request that kicked off this turn. */
  originalRequest: string;
  /** The drafted final assistant text under review. */
  draftedResponse: string;
  /** Conversation's todo state at gate time. */
  todos: TodoItem[];
  /** Tool calls produced by the executor in this turn. */
  toolCallTrace: ToolCallTraceEntry[];
  /**
   * Pre-resolved evaluator language model. When undefined, the
   * evaluator falls back to the executor's currently-active model
   * (same-context-fresh-window behavior).
   */
  evaluatorModel?: LanguageModel | null;
  /**
   * Read-only tool subset the evaluator may use to ground factual
   * claims. When undefined or empty, the evaluator runs without tools
   * (pure context-based judgment). When set, the gate enables
   * with-tools mode in the evaluator.
   */
  evaluatorTools?: ToolSet;
  /**
   * Hard cap on evaluator research steps when tools are enabled.
   * Each step is one LLM round-trip plus optional tool calls. Default
   * is in the evaluator (5).
   */
  evaluatorMaxSteps?: number;
  /**
   * Abort signal for the evaluator call. Threading the agent's outer
   * abort signal here ensures a user-initiated stop also cancels the
   * evaluator.
   */
  abortSignal?: AbortSignal;
}

/**
 * Run the gate end-to-end: decide, optionally evaluate, record telemetry.
 *
 * Always returns a `GateOutcome`. Telemetry is best-effort: if the
 * IndexedDB write fails (e.g. fake-indexeddb edge case in tests), we log
 * and continue. The user's response should never be blocked by a
 * telemetry failure.
 */
export async function runCompletionCheck(
  input: RunCompletionCheckInput,
): Promise<GateOutcome> {
  const decision = shouldGate({
    finalText: input.draftedResponse,
    todos: input.todos,
    toolCallTrace: input.toolCallTrace,
  });

  if (!decision.gate) {
    const outcome: GateOutcome = {
      kind: "skipped",
      reason: decision.reason,
    };
    await recordTelemetrySafe({
      conversationId: input.conversationId,
      turnIndex: input.turnIndex,
      rejectionRound: input.rejectionRound,
      outcomeKind: "skipped",
      verdict: null,
      skipReason: decision.reason,
    });
    return outcome;
  }

  let verdict: EvaluatorVerdict;
  try {
    const hasTools =
      !!input.evaluatorTools &&
      Object.keys(input.evaluatorTools).length > 0;
    verdict = await runEvaluator({
      originalRequest: input.originalRequest,
      draftedResponse: input.draftedResponse,
      todos: input.todos.map((t) => ({
        content: t.content,
        status: t.status,
      })),
      toolCallTrace: input.toolCallTrace,
      model: input.evaluatorModel,
      // With-tools mode activates when the caller explicitly provided a
      // tool subset. The evaluator does its own no-op-if-empty check
      // but we predicate `allowTools` on the caller's intent so the
      // system prompt branches correctly.
      allowTools: hasTools,
      tools: hasTools ? input.evaluatorTools : undefined,
      maxSteps: input.evaluatorMaxSteps,
      abortSignal: input.abortSignal,
    });
  } catch (err) {
    // Evaluator failure is treated as force-emit-with-warning rather
    // than blocking. We don't want a transient evaluator error to
    // break the user's task. The error is recorded in telemetry so
    // the user can see it in the diagnostics UI.
    console.warn("[completion-check] evaluator threw:", err);
    const fallbackVerdict: EvaluatorVerdict = {
      decision: "approve",
      concerns: [],
      reasoning: `Evaluator error: ${err instanceof Error ? err.message : String(err)}. Forcing emit with warning.`,
      confidence: 0,
    };
    await recordTelemetrySafe({
      conversationId: input.conversationId,
      turnIndex: input.turnIndex,
      rejectionRound: input.rejectionRound,
      outcomeKind: "force-emitted",
      verdict: fallbackVerdict,
    });
    return {
      kind: "force-emitted",
      verdict: fallbackVerdict,
      rejectionRound: input.rejectionRound,
      reason: "evaluator-error",
    };
  }

  const isApproved = verdict.decision === "approve";

  // Hit the rejection-round budget? Force-emit with the verdict's
  // concerns surfaced as a warning so the user can see what was caught.
  const exceededBudget =
    !isApproved && input.rejectionRound + 1 >= MAX_REJECTION_ROUNDS;

  let outcome: GateOutcome;
  if (isApproved) {
    outcome = { kind: "approved", verdict };
  } else if (exceededBudget) {
    outcome = {
      kind: "force-emitted",
      verdict,
      rejectionRound: input.rejectionRound,
      reason: "max-rounds-exceeded",
    };
  } else {
    outcome = {
      kind: "rejected",
      verdict,
      rejectionRound: input.rejectionRound,
    };
  }

  await recordTelemetrySafe({
    conversationId: input.conversationId,
    turnIndex: input.turnIndex,
    rejectionRound: input.rejectionRound,
    outcomeKind: outcome.kind,
    verdict,
  });

  return outcome;
}

async function recordTelemetrySafe(args: {
  conversationId: string;
  turnIndex: number;
  rejectionRound: number;
  outcomeKind: GateOutcome["kind"];
  verdict: EvaluatorVerdict | null;
  skipReason?: SkipReason;
}): Promise<void> {
  try {
    await completionCheckTelemetry.record(args);
  } catch (err) {
    console.warn("[completion-check] telemetry write failed:", err);
  }
}
