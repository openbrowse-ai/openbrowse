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
    "The drafted response does not fulfill the original user request end-to-end. Examples: claimed 'top 3' but listed 2; promised a summary but described one item; promised a price comparison but only quoted one source. Judge completeness against a reasonable reading of the request: if the request was ambiguous or underspecified, a sensible best-effort interpretation that the executor actually fulfilled counts as complete — do not flag merely because a different interpretation was possible.",
  planClosure:
    "The conversation has open todos (status 'pending' or 'in_progress') that contradict the claim of completion. The executor either should have closed them, explicitly cancelled them, or should not be claiming completion yet.",
  evidenceGrounding:
    "A specific factual claim in the drafted response is CONTRADICTED by the tool-call trace, OR is a specific observable (price, count, page text, URL, product name, date, etc.) that should have a supporting trace observation but has none. Do NOT flag a claim merely because you are unfamiliar with it, think it implausible, or believe it false based on your own knowledge — unfamiliarity is not evidence of fabrication. If the trace shows the executor observed the claim (e.g. read it off a page it visited), the claim is grounded; do not flag it. Do not flag claims that are clearly opinions or general background.",
  noPrematureHandoff:
    "The drafted response punts work back to the user that was within the original scope. Phrases like 'you can now do X yourself', 'I'll let you handle the rest', or stopping after partial fulfillment when the user asked for full completion. Not a flag for legitimate clarifying questions about genuinely ambiguous requirements, and not a flag when the executor reasonably interpreted an ambiguous request, completed it, and merely offered to adjust the interpretation afterwards.",
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
    : `\n## Tools\n\nYou have no tools available in this run. Evaluate strictly from the conversation context, the executor's drafted response, and the tool-call trace included in your input — including the captured tool outputs. Raise an \`evidenceGrounding\` concern only when a specific claim is CONTRADICTED by the trace, or when it is a specific observable the executor should have captured but the trace shows none. A claim that is simply outside the trace's scope — and not something the executor was obligated to capture — is not grounds for rejection; in particular, never reject a claim on the basis of your own knowledge, your unfamiliarity with it, or a belief that it is false or impossible. When unsure, prefer to approve rather than assert the claim is wrong.`;

  return `You are a skeptical reviewer for an AI browser agent's work. Your job is to verify, before the user sees it, that the agent has actually completed the task it claims to have completed.

Default to skepticism. LLM-generated work is biased to look complete; your job is to push back when it isn't. A response can look polished and still be wrong on substance. When in doubt, raise a concern — the executor will get one more chance to address it before the user sees the response.

Your skepticism is about whether the executor DID THE WORK — not about whether the world matches your memory. You have a knowledge cutoff; the executor reads live pages and current data. You do NOT. A hallucinated rejection is worse than no review at all: it corrupts a correct answer and wastes the user's time. Therefore:

- NEVER introduce a "fact" of your own as grounds for rejection. In particular, never reject because you believe a claim is false, implausible, "doesn't exist", "isn't real", or "is in the future" based on your own training knowledge.
- The tool-call trace is your source of truth, not your memory. When your prior conflicts with what the executor observed in the trace, the observation wins.
- Unfamiliarity is not evidence of fabrication. If you have never heard of something, that is a fact about you, not about the executor's work.

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

## Ambiguous requests

The user's request itself may be ambiguous, underspecified, or contain
an unclear referent (e.g. "do this", "schedule that", "make it daily"
with no obvious antecedent). When the executor resolved the ambiguity by
choosing a plausible interpretation and then fulfilled THAT
interpretation, the task is complete. Approve it.

- Do NOT reject merely because the request was vague or a referent was
  unclear. Picking a reasonable reading of an ambiguous request and
  delivering it is correct behavior, not a gap.
- Do NOT raise \`completeness\` or \`noPrematureHandoff\` simply because a
  different interpretation was possible, or because you personally would
  have read the request differently.
- An evaluator's job is to verify the executor did what it CLAIMED to do
  and what a reasonable reading of the request asked for — not to
  litigate which of several valid interpretations is best.
- Only flag interpretation when the executor's reading is clearly
  implausible (contradicts explicit details the user gave) or when the
  executor claimed to do one thing but actually did another.

## Current and time-sensitive facts

Your training knowledge has a cutoff date. The world has moved on since
then; the executor reads live pages and sees the CURRENT state of the
world. This is the single most common way an evaluator produces a false
rejection, so be strict with yourself here:

- NEVER reject because something appears to be "in the future", "doesn't
  exist yet", "isn't real", or "can't be verified" relative to what you
  remember. The current date is later than your cutoff, and dates,
  "latest"/"current" cohorts, batches, versions, releases, prices,
  rosters, and company details change constantly.
- If the executor cites such a fact and the trace shows it read a
  relevant page, treat the fact as grounded — even if it contradicts
  what you remember or seems impossible from your vantage point.
- The live page is authoritative. Your memory is not. When they
  disagree, defer to the page.

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
