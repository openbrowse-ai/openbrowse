import type { ConcernDimension, ToolCallTraceEntry } from "./types";

/**
 * Evaluator system prompt for the completion-check gate.
 *
 * Phase 1 ships the prompt skeleton even though no real evaluator call
 * happens yet (the no-op evaluator always approves). Pre-shipping the
 * prompt lets us:
 *  - Snapshot-test the prompt builder for regressions
 *  - Iterate on wording from real telemetry once Phase 2 enables real
 *    LLM calls
 *  - Keep the prompt content reviewed alongside the type surface it
 *    encodes
 *
 * Design principles, drawn from Anthropic's March 2026 harness work:
 *  - Default to skepticism. The evaluator is biased toward approval by
 *    default; the prompt explicitly counters that.
 *  - Concerns must be specific and actionable, not vibes ("looks
 *    incomplete").
 *  - Each concern names exactly one dimension. Mixed-dimension concerns
 *    get split into multiple entries.
 *  - The evaluator is allowed to use read-only tools (Phase 3+) to
 *    ground factual claims, but is not required to. Phase 2 evaluators
 *    have no tools at all.
 */

const DIMENSION_DESCRIPTIONS: Record<ConcernDimension, string> = {
  completeness:
    "The drafted response does not fulfill the original user request end-to-end. Examples: claimed 'top 3' but listed 2; promised a summary but described one item; promised a price comparison but only quoted one source.",
  planClosure:
    "The conversation has open todos (status 'pending' or 'in_progress') that contradict the claim of completion. The executor either should have closed them, explicitly cancelled them, or should not be claiming completion yet.",
  evidenceGrounding:
    "A specific factual claim in the drafted response (price, count, page text, URL, product name, date, etc.) is not supported by any tool observation in this turn. The fact may be invented or carried from stale context. Do not flag claims that are clearly opinions or general background; only flag claims that purport to describe specific observations.",
  noPrematureHandoff:
    "The drafted response punts work back to the user that was within the original scope. Phrases like 'you can now do X yourself', 'I'll let you handle the rest', or stopping after partial fulfillment when the user asked for full completion. Not a flag for legitimate clarifying questions about genuinely ambiguous requirements.",
  surfaceAccuracy:
    "The drafted response describes the page state but a verification tool call (snapshot/extract/readPage) shows the page disagrees. Only raise this concern if you actually performed a verification call this turn and observed a mismatch.",
};

/**
 * Builds the system prompt the evaluator LLM call will use. Pure function;
 * snapshot-tested.
 *
 * @param hasTools - Whether the evaluator was given any read-only tools
 *                  this run. Toggles whether the prompt encourages
 *                  surface-accuracy verification.
 */
export function buildEvaluatorSystemPrompt({
  hasTools,
}: {
  hasTools: boolean;
}): string {
  const dimensionList = (
    Object.entries(DIMENSION_DESCRIPTIONS) as [ConcernDimension, string][]
  )
    .map(([key, desc]) => `- **${key}**: ${desc}`)
    .join("\n");

  const toolGuidance = hasTools
    ? `\n## Tools\n\nYou have access to a read-only subset of the browser agent's tools (page-state inspection: snapshot, readPage, screenshot, extract, listTabs; filesystem read: Read, Glob, Grep, LS; recallMemory). The tool-call trace in your input already includes the captured output of every tool the executor ran this turn — judge most factual claims from those outputs directly. Only call a tool yourself when a specific claim genuinely cannot be checked from the trace (e.g. the executor never inspected the relevant element). Don't re-verify what the trace already shows. You have a generous research budget but reserve your final response to commit a structured verdict; do not start a new tool call once you have enough evidence to decide.`
    : `\n## Tools\n\nYou have no tools available in this run. Evaluate strictly from the conversation context, the executor's drafted response, and the tool-call trace included in your input — including the captured tool outputs. If a factual claim cannot be verified from the trace, raise an \`evidenceGrounding\` concern rather than approving by default.`;

  return `You are a skeptical reviewer for an AI browser agent's work. Your job is to verify, before the user sees it, that the agent has actually completed the task it claims to have completed.

Default to skepticism. LLM-generated work is biased to look complete; your job is to push back when it isn't. A response can look polished and still be wrong on substance. When in doubt, raise a concern — the executor will get one more chance to address it before the user sees the response.

## Your decision

Return a structured verdict with:
- **decision**: "approve" or "reject"
- **concerns**: zero or more specific, actionable concerns (empty array on approve)
- **reasoning**: a one-paragraph plain-language summary of your judgment
- **confidence**: your self-reported confidence in this verdict on [0, 1]

A reject verdict must contain at least one concern. An approve verdict must contain zero concerns.

## Concern dimensions

Every concern is tagged with exactly one of these dimensions:

${dimensionList}

If a problem spans multiple dimensions (e.g. an unverified claim that also leaves the user with unfinished work), file separate concerns — one per dimension — so the executor's fix is targeted.

## Writing useful concerns

Each concern carries TWO description fields, both required:

### \`detail\` (technical, internal voice)

Names the exact problem and points at evidence — written for an audience
of "the agent" who will revise the response. Cite text precisely.

- Bad:  "response is incomplete".
- Good: "Drafted response says 'I found the cheapest 3 options' but only lists 2 (Logitech MX, Keychron K2). The third item is missing."

Where possible, include an \`evidence\` field quoting the offending text
from the drafted response or referencing a snapshot ID (\`@e3\`) you
inspected.

### \`userSummary\` (user-facing, plain language)

One sentence the END USER will see in their chat UI. The user does NOT
see "the agent" as a separate party — they see their own conversation.
Phrasing the summary as if scolding a third party breaks the experience.

Hard rules:

1. **Observation voice.** Frame as a fact about the world, not a
   directive to anyone. "Hours might be off" — not "The agent should
   verify the hours".
2. **Never mention "the agent".** Never use prescriptive verbs
   ("should", "needs to", "must").
3. **No internal jargon.** Don't say "completeness", "evidenceGrounding",
   "tool call", "snapshot", "drafted response". Speak the user's domain.
4. **One concern, one sentence.** Soft cap ~25 words.

Good \`userSummary\` examples:

- "Hours might be off — site shows 7am–8pm on weekends, not 7pm daily."
- "Only 2 cafes listed but you asked for 3."
- "The price quoted ($149) wasn't actually verified on any page this turn."
- "The summary covers reviews but not the locations you asked about."

Bad \`userSummary\` examples (DO NOT EMIT):

- "The agent needs to verify the cafe's hours."  ← addresses the agent
- "completeness: missing item."  ← jargon
- "The drafted response fails to satisfy the surfaceAccuracy criterion." ← jargon
- "The agent should look for cafes that remain open past 7:00 PM."  ← directive voice + addresses agent

## What to NOT flag

- Style or tone preferences. The executor's voice is the user's choice.
- Length: terse responses are fine if the task is simple.
- Hypotheticals or recommendations the executor explicitly framed as "you might also consider…".
- Genuine clarifying questions about ambiguous requirements (those are not premature handoffs).
- Already-completed todos. Only \`pending\`/\`in_progress\` items count toward planClosure.

If everything checks out, approve cleanly with empty concerns. Don't manufacture problems to look diligent.
${toolGuidance}`;
}

/**
 * Builds the user-message body for the evaluator call. Combines the
 * original user request, the executor's drafted response, current todo
 * state, and a compressed tool-call trace.
 *
 * Kept as a separate builder so the prompt can be snapshot-tested
 * independent of any conversation fixture.
 */
export interface EvaluatorUserPromptInput {
  originalRequest: string;
  draftedResponse: string;
  todos: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>;
  /**
   * Per-tool-call trace from the executor's turn. Includes the call's
   * input, the captured output (or error), and the lifecycle state.
   * Captured live by `observeChunkForCompletionCheck` in the transport.
   *
   * The output capture is the single biggest input to evaluator quality:
   * with it, most factual claims can be judged from context without the
   * evaluator having to re-call tools to see the same page state.
   */
  toolCallTrace: ToolCallTraceEntry[];
}

export function buildEvaluatorUserPrompt(
  input: EvaluatorUserPromptInput,
): string {
  const todoBlock =
    input.todos.length === 0
      ? "(no todos in this conversation)"
      : input.todos
          .map(
            (t, i) =>
              `${i + 1}. [${t.status.toUpperCase()}] ${t.content}`,
          )
          .join("\n");

  // Render each tool call as `<n>. <name> [<state>]` with `input:` and
  // `output:` sub-lines. Outputs are already truncated by the observer;
  // we don't re-truncate here. The state tag lets the evaluator
  // distinguish completed/errored/denied/pending without parsing the
  // output text.
  const traceBlock =
    input.toolCallTrace.length === 0
      ? "(no tool calls in this turn)"
      : input.toolCallTrace
          .map((c, i) => {
            const stateTag = c.state === "completed" ? "" : ` [${c.state}]`;
            const inputLine = `   input: ${c.inputSummary || "(no input)"}`;
            let outputLine: string;
            switch (c.state) {
              case "completed":
                outputLine = `   output: ${c.outputSummary ?? "(no output)"}`;
                break;
              case "errored":
                outputLine = `   error: ${c.outputSummary ?? "(unknown error)"}`;
                break;
              case "denied":
                outputLine = `   (user denied this tool call — no output produced)`;
                break;
              case "pending":
                outputLine = `   (call did not complete before the turn ended)`;
                break;
            }
            return `${i + 1}. ${c.name}${stateTag}\n${inputLine}\n${outputLine}`;
          })
          .join("\n");

  return `## Original user request

${input.originalRequest}

## Drafted final response (under review)

${input.draftedResponse}

## Current todo state

${todoBlock}

## Tool-call trace from this turn

Each entry below records what the executor did this turn AND what the
tool returned. Use the captured outputs to judge factual claims
directly — only call verification tools yourself if a claim cannot be
checked against the trace.

${traceBlock}

## Your task

Decide whether the drafted final response should be sent to the user. Apply the rubric in your system prompt. Be specific in concerns; cite evidence when possible.`;
}
