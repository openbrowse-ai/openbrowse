import { tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * `askUser` — a multiple-choice question the user answers in the chat
 * composer.
 *
 * This tool is deliberately registered WITHOUT an `execute` function,
 * which makes it a "client-side tool" in AI SDK terms. That single fact
 * drives the whole design:
 *
 *   - The SW-hosted agent loop only continues while every tool call in a
 *     step has a result (`ai/dist/index.mjs`: `clientToolCalls.length > 0
 *     && clientToolOutputs.length === clientToolCalls.length`). A call
 *     with no `execute` produces no result, so the run TERMINATES with
 *     the part parked in `input-available`. No service-worker keepalive,
 *     no port round-trip, no open promise waiting on a renderer.
 *   - The renderer finds that pending part (`findPendingQuestion`),
 *     mounts `<QuestionCard>` in the composer slot, and answers it with
 *     `addToolOutput({ tool: "askUser", toolCallId, output })`. The
 *     `sendAutomaticallyWhen` predicate in `useAgentChat` then starts a
 *     fresh run whose history carries the answer as a normal tool result.
 *   - Because the pending state lives in the persisted message list
 *     rather than in memory, a question survives a reload AND a
 *     service-worker restart. (`healPendingTools` only runs on
 *     submit/retry/edit/compaction, never on plain load.)
 *
 * That last point is why there is NO timeout on answering. Nothing is
 * held open while a question waits — no promise, no port, no keepalive —
 * so a question costs nothing to leave pending and can be answered the
 * next day. An earlier revision auto-resolved after 10 idle minutes to
 * stop an unattended task "parking forever", but the run has already
 * ended by then: the only thing the timer bought was throwing the
 * question away before the user got back to it. `dismissed` remains the
 * explicit way out, and the `question-pending` notification is what
 * tells the user an answer is wanted.
 *
 * The shape is modelled on Claude Code's `AskUserQuestion` — question +
 * short header chip + 2-4 labelled options + `multiSelect` — with two
 * deliberate divergences, both noted at their definitions: answers come
 * back structured rather than as a comma-joined string, and the outcome
 * is an explicit enum so "dismissed" is distinguishable from "answered"
 * without inferring it from an empty array.
 *
 * NOT registered for headless runs (scheduled tasks, MCP `task`) or for
 * subagents — there is no human on those surfaces, and a question there
 * would end the run mid-task with nothing to show. See
 * `HEADLESS_NO_HUMAN_DROP_TOOLS` and the `askUser` guard in
 * `runSubagentAgentLoop`.
 */

/**
 * Max length of the `header` chip. Claude Code uses 12; we allow a
 * little more because browser-task headers tend to name a real-world
 * attribute ("Shipping speed", "Seat class") rather than a code concept
 * ("Library", "Approach").
 */
export const ASK_USER_HEADER_MAX = 16;

/** Min/max options per question. Both bounds are load-bearing — see the
 *  `options` description, which states them to the model too. */
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 4;

/** Min/max questions per call. */
export const ASK_USER_MIN_QUESTIONS = 1;
export const ASK_USER_MAX_QUESTIONS = 4;

const optionSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe(
      'The choice as the user reads it. Concise — 1-5 words. If you recommend one option, make it the FIRST option and append " (Recommended)" to its label.',
    ),
  description: z
    .string()
    .min(1)
    .describe(
      "One line on what this option means or what you will do if it is chosen. Name the tradeoff, don't restate the label.",
    ),
});

const questionSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      'The full question, ending in a question mark. Example: "Which of these three flights should I book?" If multiSelect is true, phrase it for multiple answers ("Which filters should I apply?").',
    ),
  header: z
    .string()
    .min(1)
    .max(ASK_USER_HEADER_MAX)
    .describe(
      `Very short label rendered as a chip above the question (max ${ASK_USER_HEADER_MAX} chars). Examples: "Flight", "Shipping", "Which account".`,
    ),
  options: z
    .array(optionSchema)
    .min(ASK_USER_MIN_OPTIONS)
    .max(ASK_USER_MAX_OPTIONS)
    .describe(
      `The choices. Must be ${ASK_USER_MIN_OPTIONS}-${ASK_USER_MAX_OPTIONS} — this is a hard schema bound, so group or split rather than exceeding it. Each option is a distinct choice, mutually exclusive unless multiSelect is set. Do NOT add an "Other" option; the UI always provides a free-text field.`,
    ),
  multiSelect: z
    .boolean()
    .default(false)
    .describe(
      "True to let the user pick more than one option. Use when the choices combine rather than compete.",
    ),
});

const parameters = z
  .object({
    questions: z
      .array(questionSchema)
      .min(ASK_USER_MIN_QUESTIONS)
      .max(ASK_USER_MAX_QUESTIONS)
      .describe(
        `The questions to ask (${ASK_USER_MIN_QUESTIONS}-${ASK_USER_MAX_QUESTIONS}). Ask everything you are blocked on in ONE call — a second call means a second interruption.`,
      ),
  })
  // Answers are keyed back to questions by their text (there are no ids —
  // see the `answers` field on the output schema for why), and the card
  // renders one row per option label. Duplicates in either position would
  // make the result ambiguous, so reject them at the schema boundary with
  // a message the model can act on.
  .refine(
    (v) => {
      const texts = v.questions.map((q) => q.question);
      if (new Set(texts).size !== texts.length) return false;
      return v.questions.every((q) => {
        const labels = q.options.map((o) => o.label);
        return new Set(labels).size === labels.length;
      });
    },
    {
      message:
        "Question texts must be unique, and option labels must be unique within each question",
      path: ["questions"],
    },
  );

/**
 * The raw input schema. Exported alongside the tool factory so the
 * Anthropic schema-compatibility guard (`tool-input-schema.test.ts`) can
 * assert this serializes to a top-level object schema — the `.refine`
 * above is the kind of thing that can silently break that.
 */
export const askUserParameters = parameters;

/** Public input type, consumed by the chat UI to type the streamed
 *  `part.input` it receives from the SDK. */
export type AskUserInput = z.infer<typeof parameters>;
export type AskUserQuestion = AskUserInput["questions"][number];
export type AskUserOption = AskUserQuestion["options"][number];

const answerSchema = z.object({
  /** Echoes the question text so the result is self-describing after
   *  compaction truncates or drops the originating call's input. */
  question: z.string(),
  header: z.string(),
  /**
   * Labels the user picked, in the order the options were presented.
   * Empty when the user answered only via the free-text field.
   *
   * Divergence from Claude Code, which joins multi-select answers into a
   * single comma-separated string keyed by question text. That is lossy
   * (a label containing a comma is unrecoverable) and it has to survive
   * this codebase's serialize → chatDb → compaction round-trips, so we
   * keep the array.
   */
  selected: z.array(z.string()),
  /**
   * Free text the user typed into the always-present "Other" field.
   *
   * For a single-select question this is an ALTERNATIVE to `selected`
   * rather than an addition — the UI clears one when the user supplies
   * the other, so at most one of the two is populated. When
   * `multiSelect` is set both can appear, since those choices combine.
   */
  other: z.string().optional(),
});

const outputSchema = z.object({
  /**
   * Explicit outcome rather than a boolean, so the model can tell the two
   * cases apart without inferring from an empty array:
   *
   *  - `answered`   — the user submitted; `answers` is populated.
   *  - `dismissed`  — the user declined to answer and told the agent to
   *                   proceed on its own judgement.
   *
   * There is deliberately no timeout outcome. A question waits until it
   * is answered — see the module JSDoc on why parking is safe.
   */
  outcome: z.enum(["answered", "dismissed"]),
  /**
   * One entry per question the user actually answered — NOT necessarily
   * one per question asked. The user may submit having skipped some, and
   * a skipped question is omitted rather than returned with an empty
   * `selected`, which would read as "replied and said nothing". Each
   * entry echoes its own question text, so a short array is unambiguous.
   */
  answers: z.array(answerSchema),
});

export type AskUserOutput = z.infer<typeof outputSchema>;

const description = `Ask the user one to ${ASK_USER_MAX_QUESTIONS} multiple-choice questions and wait for their answer. Use ONLY when you are blocked on a decision that is genuinely the user's to make and that you cannot resolve from the request, the page, or a sensible default.

Calling this stops the task until the user responds, so the bar is high:

- Ask when the choice is irreversible or expensive to undo, or when it depends on a preference or fact you have no way to observe: which of these flights to book, which saved card to pay with, which account to post from, what size to order.
- Do NOT ask for permission or progress ("should I continue?", "want me to keep going?", "is this right so far?"). Pick the next step and take it.
- Do NOT ask what you can find out. Read the page, check the account, look at the earlier turns.
- Do NOT ask when a reasonable default exists. Choose it, say which one you chose in your final message, and offer to change it.

Notes:
- The user can always type a custom answer instead of picking an option, so never include an "Other" option yourself.
- Ask everything you are blocked on in a single call. Two calls is two interruptions.
- Set \`multiSelect: true\` when the choices combine rather than compete.
- The user can skip a question. Any question missing from \`answers\` was not answered — use your best judgement for that one and say what you assumed.
- The user may decline to answer at all: \`outcome: "dismissed"\` comes back with an empty \`answers\`. Proceed with your best interpretation and say what you assumed. Never re-ask; a second question fares no better than the first.
- A question waits indefinitely, so the user may answer much later. Do not treat a long gap as a reason to change course.`;

/**
 * Build the SDK tool. Note the absence of `execute` — that is what makes
 * this a client-side tool; see the module JSDoc. It deliberately does
 * NOT go through `toSDKTool`, whose `BrowserTool` contract requires an
 * `execute` and whose approval/allowlist machinery has nothing to gate
 * here (the question IS the interaction).
 */
export function createAskUserTool(): ToolSet[string] {
  return tool({
    description,
    inputSchema: parameters,
    outputSchema,
  });
}

/** Tool key as registered in the agent's tool set. Exported so UI and
 *  policy code match on a constant instead of a bare string literal. */
export const ASK_USER_TOOL_NAME = "askUser";
