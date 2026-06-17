import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { getCurrentAgentModel } from "../current-agent-model";
import {
  buildEvaluatorSystemPrompt,
  buildEvaluatorUserPrompt,
  type EvaluatorUserPromptInput,
} from "./prompt";
import type { ConcernDimension, EvaluatorVerdict } from "./types";

/**
 * Input shape for the evaluator entry point. Same across no-op and real
 * evaluator implementations so the gate orchestrator can swap them
 * without changing call sites.
 */
export interface RunEvaluatorInput extends EvaluatorUserPromptInput {
  /**
   * Pre-resolved language model to use for the evaluator call.
   *
   * When `undefined` or `null`, the evaluator falls back to the
   * executor's currently-active model via `getCurrentAgentModel()` —
   * giving "same-model-fresh-context" behavior, Anthropic's recommended
   * default per their March 2026 harness post.
   *
   * Tests pass a mock LanguageModel here to drive deterministic
   * verdicts; production callers (`agent-transport.ts`) resolve a
   * provider override (settings.completionCheck.evaluatorModel) before
   * calling.
   */
  model?: LanguageModel | null;
  /**
   * Optional abort signal. The transport hands this through from the
   * outer agent run so a user-initiated stop also cancels the evaluator
   * call rather than orphaning a request to the provider.
   */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Zod schema describing the verdict shape we ask the LLM to emit.
//
// Kept structurally aligned with the `EvaluatorVerdict` TS type but does
// NOT include the reserved Phase 6 fields (`scores`, `trend`). The model
// shouldn't be encouraged to fabricate scores in binary mode; if/when we
// add scored mode we extend the schema then.
//
// Concern shape mirrors `Concern` in types.ts. We don't import the TS
// type directly because Zod can't widen-then-narrow it — we'd lose the
// dimension union. We do enforce a known dimension at the Zod layer so
// providers that emit free-form strings get a useful validation error.
// ---------------------------------------------------------------------------

const CONCERN_DIMENSIONS: readonly ConcernDimension[] = [
  "completeness",
  "planClosure",
  "noPrematureHandoff",
] as const;

const concernSchema = z.object({
  dimension: z.enum(CONCERN_DIMENSIONS as readonly [string, ...string[]]),
  detail: z
    .string()
    .min(1)
    .describe(
      "Internal: specific, actionable description of the concern in evaluator voice. Used to construct follow-up feedback for the agent and the audit-trail export. Cite exact text where possible.",
    ),
  userSummary: z
    .string()
    .min(1)
    .max(180)
    .describe(
      "REQUIRED. User-facing one-sentence summary of the concern, in plain observation voice. Do NOT address 'the agent' or use prescriptive verbs ('should', 'needs to', 'must'). NO internal jargon (dimension names, tool names, snapshot refs). Frame as observations the user can understand. Examples — good: 'Only 2 cafes listed but you asked for 3'. Bad: 'The agent needs to add a third cafe.' Soft cap ~25 words, hard cap 180 chars.",
    ),
  evidence: z
    .string()
    .optional()
    .describe(
      "Optional supporting quote from the drafted response. Internal/export only — not surfaced in the inline UI.",
    ),
});

const verdictSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  concerns: z.array(concernSchema),
  reasoning: z
    .string()
    .min(1)
    .describe("One-paragraph plain-language summary of the verdict."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Self-reported confidence on [0, 1]."),
});

/**
 * Evaluator entry point.
 *
 * Single-shot `generateObject` against the conversation context — the
 * original request, the drafted response, the todo list, and the
 * captured tool-call trace. No tools; the evaluator does not make its
 * own verification calls.
 *
 * History note: an earlier revision supported a with-tools mode that
 * could spend a research budget on snapshot/extract/readPage calls
 * before committing to a verdict. We removed it (a) the with-tools path
 * dominated end-of-turn latency, (b) the dimensions that benefited most
 * from it (`evidenceGrounding`, `surfaceAccuracy`) were also the most
 * false-positive-prone and have been retired, (c) the no-tools path is
 * sufficient for the remaining dimensions, all of which are judged
 * against in-context material rather than live page state.
 *
 * Returns a verdict validated against {@link verdictSchema}. The schema
 * enforces the binary `decision` + dimensional concerns shape; concerns
 * with unknown dimensions are rejected at validation time so downstream
 * gate logic can trust `verdict.concerns[].dimension` to be a known
 * `ConcernDimension`.
 *
 * Failure modes — handled, not propagated:
 *  - No model available: returns optimistic approve with confidence 0
 *    and a "no model configured" reasoning string. The user's response
 *    is never blocked by an evaluator unavailability.
 *  - LLM call throws: re-thrown. The gate orchestrator catches and
 *    converts to `force-emitted` (reason: "evaluator-error").
 *  - Schema validation failure on the LLM output: the AI SDK retries
 *    internally; if it still fails, the error reaches the gate
 *    orchestrator and is treated as "evaluator-error".
 *
 * Internal-consistency normalization:
 *  - If the LLM returns `decision: "reject"` with an empty concerns
 *    array, we promote that to a single synthetic concern in the
 *    `completeness` bucket so the rejection feedback isn't empty.
 *  - If the LLM returns `decision: "approve"` with non-empty concerns,
 *    we keep concerns but trust the decision (the LLM may have
 *    flagged minor caveats while still concluding approval). The
 *    rejection-loop wiring only triggers on `decision === "reject"`.
 */
export async function runEvaluator(
  input: RunEvaluatorInput,
): Promise<EvaluatorVerdict> {
  const model = input.model ?? getCurrentAgentModel();
  if (!model) {
    return {
      decision: "approve",
      concerns: [],
      reasoning:
        "(evaluator unavailable: no language model configured for this run)",
      confidence: 0,
    };
  }

  const system = buildEvaluatorSystemPrompt();
  const prompt = buildEvaluatorUserPrompt({
    originalRequest: input.originalRequest,
    draftedResponse: input.draftedResponse,
    todos: input.todos,
    toolCallTrace: input.toolCallTrace,
  });

  const result = await generateObject({
    model,
    schema: verdictSchema,
    system,
    prompt,
    abortSignal: input.abortSignal,
  });
  const raw = result.object;

  // The Zod enum was widened to `string` to accept arbitrary providers'
  // outputs at parse time; narrow back to ConcernDimension here. Any
  // unknown dimension was already rejected by the schema, so this cast
  // is safe.
  const concerns = raw.concerns.map((c) => ({
    dimension: c.dimension as ConcernDimension,
    detail: c.detail,
    userSummary: c.userSummary,
    evidence: c.evidence,
  }));

  // Repair an internally-inconsistent reject-with-no-concerns verdict.
  if (raw.decision === "reject" && concerns.length === 0) {
    concerns.push({
      dimension: "completeness",
      detail:
        "Evaluator rejected without enumerating concerns; rejection treated as completeness gap.",
      userSummary: "The response may be incomplete.",
      evidence: undefined,
    });
  }

  return {
    decision: raw.decision,
    concerns,
    reasoning: raw.reasoning,
    confidence: raw.confidence,
  };
}
