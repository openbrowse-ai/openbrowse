import {
  generateObject,
  generateText,
  NoOutputGeneratedError,
  Output,
  stepCountIs,
  type LanguageModel,
  type StepResult,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { getCurrentAgentModel } from "../current-agent-model";
import {
  buildEvaluatorSystemPrompt,
  buildEvaluatorUserPrompt,
  type EvaluatorUserPromptInput,
} from "./prompt";
import {
  TRACE_OUTPUT_TRUNCATE_CHARS,
  type ConcernDimension,
  type EvaluatorVerdict,
} from "./types";

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
   * When true AND `tools` is non-empty, the evaluator runs via
   * `generateText` with the provided tools available and a
   * structured-output spec. The model may call read-only browser /
   * filesystem tools to ground factual claims (especially for
   * `surfaceAccuracy` and `evidenceGrounding` concerns) before
   * committing to a verdict. The `stopWhen: stepCountIs(N)` cap
   * bounds the research budget per evaluator call.
   *
   * When false or `tools` is empty/undefined, the evaluator runs via
   * `generateObject` with no tools — pure context-based judgment.
   */
  allowTools?: boolean;
  /**
   * Read-only tool subset the evaluator may call. The caller is
   * responsible for filtering destructive tools (clickElement,
   * navigate, executeOnPage, todoWrite, memory writes, etc.) — the
   * evaluator does not validate this list. Production wiring lives in
   * `agent-transport.ts` and only includes snapshot/readPage/screenshot/
   * extract/listTabs from browser tools and Read/Glob/Grep/LS from
   * filesystem tools.
   */
  tools?: ToolSet;
  /**
   * Hard cap on evaluator research steps when `allowTools` is true.
   * Each step is one LLM round-trip (potentially with tool calls).
   * Default: 20 — generous enough that a properly-prompted evaluator
   * never hits the cap while still bounding pathological loops. The
   * earlier 5-step cap was prone to mid-tool-call cap-hits that
   * produced `NoOutputGeneratedError`; the two-stage fallback (see
   * below) is the actual safety net, so this cap exists only to bound
   * runaway calls.
   */
  maxSteps?: number;
  /**
   * Optional abort signal. The transport hands this through from the
   * outer agent run so a user-initiated stop also cancels the evaluator
   * call rather than orphaning a request to the provider.
   */
  abortSignal?: AbortSignal;
}

const DEFAULT_EVALUATOR_MAX_STEPS = 20;

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
  "evidenceGrounding",
  "noPrematureHandoff",
  "surfaceAccuracy",
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
      "REQUIRED. User-facing one-sentence summary of the concern, in plain observation voice. Do NOT address 'the agent' or use prescriptive verbs ('should', 'needs to', 'must'). NO internal jargon (dimension names, tool names, snapshot refs). Frame as observations the user can understand. Examples — good: 'Hours might be inaccurate — site shows 7am–8pm weekends, not 7pm'. Bad: 'The agent needs to verify the cafe's hours.' Soft cap ~25 words, hard cap 180 chars.",
    ),
  evidence: z
    .string()
    .optional()
    .describe(
      "Optional supporting quote or snapshot reference. Internal/export only — not surfaced in the inline UI.",
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
 * Two execution modes, chosen at call time:
 *
 *  1. **No-tools mode** (default): one-shot `generateObject` against the
 *     evaluator model. Pure context-based judgment from the original
 *     request, drafted response, todo list, and tool-call trace.
 *
 *  2. **With-tools mode**: `generateText` with a read-only tool subset
 *     plus an `Output.object` spec, capped by `stepCountIs(maxSteps)`.
 *     The evaluator may take a few verification calls (snapshot,
 *     extract, readPage, etc.) to ground factual claims before
 *     committing to a verdict. Especially useful for the
 *     `surfaceAccuracy` and `evidenceGrounding` concern dimensions.
 *
 * Both modes return a verdict validated against {@link verdictSchema}.
 * The schema enforces the binary `decision` + dimensional concerns
 * shape; concerns with unknown dimensions are rejected at validation
 * time so downstream gate logic can trust
 * `verdict.concerns[].dimension` to be a known `ConcernDimension`.
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

  const useTools =
    !!input.allowTools && !!input.tools && Object.keys(input.tools).length > 0;

  const system = buildEvaluatorSystemPrompt({ hasTools: useTools });
  const prompt = buildEvaluatorUserPrompt({
    originalRequest: input.originalRequest,
    draftedResponse: input.draftedResponse,
    todos: input.todos,
    toolCallTrace: input.toolCallTrace,
  });

  let raw: z.infer<typeof verdictSchema>;
  if (useTools) {
    // generateText + Output.object lets the model take a few
    // verification tool calls before committing to a structured
    // verdict in a single API surface. The `stepCountIs` cap bounds
    // research depth.
    const result = await generateText({
      model,
      system,
      prompt,
      tools: input.tools,
      stopWhen: stepCountIs(input.maxSteps ?? DEFAULT_EVALUATOR_MAX_STEPS),
      output: Output.object({ schema: verdictSchema }),
      abortSignal: input.abortSignal,
    });

    // Two-stage commit: `result.output` throws `NoOutputGeneratedError`
    // when the final step's `finishReason !== "stop"` — which happens
    // most often when the model runs out of step budget mid-tool-call
    // and never gets a chance to emit the structured verdict. Rather
    // than letting that bubble up as an "evaluator-error" force-emit,
    // run a follow-up `generateObject` (no tools) that asks the model
    // to commit a verdict from the verification work it already did.
    // The accumulated tool calls and outputs from `result.steps` are
    // included so the second-stage call has full context.
    //
    // Schema-validation errors (the model committed a verdict but it
    // didn't match the schema) are NOT recoverable here and propagate.
    try {
      // The SDK types `result.output` as `InferCompleteOutput<OUTPUT>`
      // which resolves to the schema's inferred type, but Output's
      // generic propagation through `generateText`'s return type tends
      // to lose the tight type. Re-validate against our Zod schema for
      // both runtime safety and a tighter compile-time shape.
      raw = verdictSchema.parse(result.output);
    } catch (err) {
      if (!NoOutputGeneratedError.isInstance(err)) throw err;

      console.warn(
        "[completion-check] evaluator hit step cap without committing; running second-stage commit",
      );
      const stepTranscript = summarizeEvaluatorSteps(result.steps);
      const followupPrompt = `${prompt}\n\n## Your verification work so far\n\nYou used your full research budget. The captured tool calls and outputs from your verification work this turn are below. Commit a verdict NOW from this evidence — you may not request more tools.\n\n${stepTranscript}`;
      const followup = await generateObject({
        model,
        schema: verdictSchema,
        system,
        prompt: followupPrompt,
        abortSignal: input.abortSignal,
      });
      raw = followup.object;
    }
  } else {
    const result = await generateObject({
      model,
      schema: verdictSchema,
      system,
      prompt,
      abortSignal: input.abortSignal,
    });
    raw = result.object;
  }

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

/**
 * Compress the steps from a `generateText` run into a flat transcript
 * for the second-stage commit prompt.
 *
 * Each step contributes the tool calls it made (name + truncated input)
 * and the tool results it received (truncated). We deliberately drop
 * the model's interstitial text/reasoning — only the verification
 * evidence matters for the commit-now prompt, and including reasoning
 * tends to bias the second-stage call to mirror the first-stage's
 * incomplete thought process.
 *
 * Truncation reuses {@link TRACE_OUTPUT_TRUNCATE_CHARS} so the trace
 * stays bounded. The transcript is plain text formatted for the LLM,
 * not a structured shape; tests assert on substrings rather than shape.
 */
function summarizeEvaluatorSteps(
  steps: ReadonlyArray<StepResult<ToolSet>>,
): string {
  if (steps.length === 0) {
    return "(no verification work was completed)";
  }

  const lines: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const toolCalls = step.toolCalls ?? [];
    const toolResults = step.toolResults ?? [];

    if (toolCalls.length === 0 && toolResults.length === 0) continue;

    lines.push(`### Step ${i + 1}`);
    for (const call of toolCalls) {
      const name = call.toolName ?? "(unknown)";
      let inputStr: string;
      try {
        inputStr =
          typeof call.input === "string"
            ? call.input
            : JSON.stringify(call.input ?? {});
      } catch {
        inputStr = "(input not serializable)";
      }
      const inputTruncated =
        inputStr.length > 200 ? inputStr.slice(0, 200) + "… (truncated)" : inputStr;
      lines.push(`- called \`${name}\` with: ${inputTruncated}`);
    }
    for (const result of toolResults) {
      const name = result.toolName ?? "(unknown)";
      // `result.output` is the shape returned by the tool; can be
      // anything (string, object, array). Stringify and truncate.
      let outputStr: string;
      try {
        const out =
          (result as { output?: unknown }).output ??
          (result as { result?: unknown }).result;
        outputStr = typeof out === "string" ? out : JSON.stringify(out ?? null);
      } catch {
        outputStr = "(output not serializable)";
      }
      const outputTruncated =
        outputStr.length > TRACE_OUTPUT_TRUNCATE_CHARS
          ? outputStr.slice(0, TRACE_OUTPUT_TRUNCATE_CHARS) + "… (truncated)"
          : outputStr;
      lines.push(`  → \`${name}\` returned: ${outputTruncated}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(no tool calls observed)";
}
