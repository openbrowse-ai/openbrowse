import { Check, ChevronLeft, ChevronRight, CircleHelp } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import type { AskUserOutput, AskUserQuestion } from "@/lib/agent/tools/ask-user";
import { cn } from "@/lib/utils";
import { resolveQuestionKeyAction } from "./question-key-action";

interface QuestionCardProps {
  toolCallId: string;
  /** Complete question set — `findPendingQuestion` only returns calls in
   *  `input-available`, so no partial-input defenses are needed here. */
  questions: AskUserQuestion[];
  /** Submit the user's answer as the tool's output. */
  onAnswer: (toolCallId: string, output: AskUserOutput) => void;
}

/** Per-question working state. `selected` holds option labels. */
interface Draft {
  selected: string[];
  other: string;
}

/** A question is answered when an option is picked or free text typed. */
export function isQuestionAnswered(draft: Draft): boolean {
  return draft.selected.length > 0 || draft.other.trim().length > 0;
}

/**
 * Whether the primary button can run right now.
 *
 * The two jobs of that button have different requirements:
 *
 *   - "Next question" ADVANCES, so it requires an answer to the question
 *     in front of the user. Without this the button walked straight past
 *     an untouched question, which read as though the card had accepted
 *     an answer that was never given.
 *   - "Submit answer(s)" FINISHES, so it only requires an answer
 *     somewhere. It deliberately does NOT require the last question to be
 *     answered: reaching the last question via the button means every
 *     earlier one is already answered, so demanding it too would let a
 *     user who arrowed forward to a skipped question get stranded with no
 *     way to send the answers they had.
 *
 * Free navigation (arrows, pips, ← / →) is intentionally not gated — the
 * user can always look ahead and come back.
 */
export function canRunPrimary(drafts: Draft[], index: number): boolean {
  const isLast = index === drafts.length - 1;
  return isLast
    ? drafts.some(isQuestionAnswered)
    : isQuestionAnswered(drafts[index]);
}

/**
 * Apply an option click to a draft.
 *
 * In single-select the free-text answer is an ALTERNATIVE to the options —
 * the field literally reads "Or type your own answer" — so picking an
 * option clears it. Letting both stand produced the bug this guards: a
 * checked radio sitting above contradicting typed text, and an output
 * carrying `selected` AND `other` with no way for the model to tell which
 * the user meant.
 *
 * In multi-select they coexist. `multiSelect` is defined as "the choices
 * combine rather than compete", so a typed answer combines with the picks
 * the same way they combine with each other.
 */
export function applyOptionPick(
  draft: Draft,
  question: AskUserQuestion,
  label: string,
): Draft {
  if (!question.multiSelect) {
    // Re-picking the same option clears it, so the user can back out of a
    // choice without answering.
    return { selected: draft.selected.includes(label) ? [] : [label], other: "" };
  }
  return {
    ...draft,
    selected: draft.selected.includes(label)
      ? draft.selected.filter((l) => l !== label)
      : [...draft.selected, label],
  };
}

/**
 * Apply free-text input to a draft.
 *
 * The mirror of {@link applyOptionPick}: in single-select, typing IS the
 * answer, so it clears any picked option. Only non-blank input clears —
 * a stray space shouldn't silently discard a deliberate pick. Emptying
 * the box again doesn't restore the option; the user picks it again.
 */
export function applyOtherText(
  draft: Draft,
  question: AskUserQuestion,
  value: string,
): Draft {
  if (!question.multiSelect && value.trim().length > 0) {
    return { selected: [], other: value };
  }
  return { ...draft, other: value };
}

/**
 * Collapse drafts into the tool output.
 *
 * Questions the user skipped are OMITTED rather than emitted with an empty
 * `selected`: the user can submit from the last question without having
 * answered every one, and an empty answer would read to the model as "the
 * user replied and said nothing" instead of "the user didn't answer". Each
 * answer echoes its own question text, so a short `answers` array is
 * unambiguous about which ones came back.
 */
export function buildAskUserOutput(
  questions: AskUserQuestion[],
  drafts: Draft[],
  outcome: AskUserOutput["outcome"],
): AskUserOutput {
  if (outcome !== "answered") return { outcome, answers: [] };
  return {
    outcome,
    answers: questions.flatMap((q, i) => {
      const draft = drafts[i];
      if (!isQuestionAnswered(draft)) return [];
      const other = draft.other.trim();
      return [
        {
          question: q.question,
          header: q.header,
          // Preserve presentation order rather than click order — the model
          // reads these against the options it authored.
          selected: q.options
            .map((o) => o.label)
            .filter((label) => draft.selected.includes(label)),
          ...(other.length > 0 && { other }),
        },
      ];
    }),
  };
}

/**
 * The composer-slot card for a pending `askUser` call — the question
 * analogue of {@link PlanApprovalCard}, mounted in the same place
 * (replacing {@link ChatInput}) so answering is the only thing the user
 * can do next.
 *
 * **One question at a time.** A 4-question call with 4 described options
 * each is far taller than the composer slot, and showing them stacked
 * pushed the primary action below the fold — the user had to scroll to
 * find the button that submits. So the card paginates: header carries
 * position + arrows, the body scrolls if a single question is still too
 * tall, and the action row is pinned so it is always reachable. The frame
 * is capped just short of the panel viewport (matching the
 * `calc(100vh-180px)` allowance ChatView uses for its empty state) so a
 * long question can use the whole panel rather than a fraction of it.
 *
 * **The primary action is positional.** It reads "Next question" on every
 * question but the last, and "Submit answer(s)" on the last — so the label
 * always describes what the button will do, and Enter always does what the
 * label says. It is disabled until the question on screen is answered (see
 * {@link canRunPrimary}); skipping is still possible with the arrows or
 * pips, and a skipped question simply doesn't appear in the output (see
 * {@link buildAskUserOutput}).
 *
 * Other interaction details:
 *   - single-select renders as radios, `multiSelect` as checkboxes
 *   - an "Other" free-text field is ALWAYS present and is never modelled
 *     by the tool schema (see the `options` description in `ask-user.ts`).
 *     In single-select it REPLACES a picked option rather than adding to
 *     it; in multi-select it joins them. See {@link applyOtherText}.
 *   - number keys 1-9 pick options in the CURRENT question
 *   - ← / → move between questions from anywhere in the card, including
 *     while an option button or nav arrow holds focus. They are inert
 *     only inside the free-text box, where they must move the caret — so
 *     Alt/Cmd + ← / → also navigate and DO work from in there, and Escape
 *     blurs the box to hand the bare arrows back. See
 *     {@link resolveQuestionKeyAction}, where this all lives and is tested.
 *   - Enter runs the primary action and Shift+Enter inserts a newline in
 *     the free-text box, matching {@link ChatInput}. Cmd/Ctrl+Enter
 *     dismisses, matching {@link PlanApprovalCard}.
 *   - there is NO answer deadline: a question waits until it is answered,
 *     even if that is tomorrow. See the module JSDoc in `ask-user.ts`.
 */
export function QuestionCard({
  toolCallId,
  questions,
  onAnswer,
}: QuestionCardProps) {
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    questions.map(() => ({ selected: [], other: "" })),
  );
  const [index, setIndex] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const otherRef = useRef<HTMLTextAreaElement | null>(null);

  // Guards against a double submit: the idle timer and a keyboard
  // accelerator can both fire in the same tick as a click, and each
  // `onAnswer` starts a billable agent run.
  const resolvedRef = useRef(false);

  const multi = questions.length > 1;
  const current = questions[index];
  const draft = drafts[index];
  const isLast = index === questions.length - 1;
  const canAdvance = useMemo(() => canRunPrimary(drafts, index), [drafts, index]);

  const resolve = useCallback(
    (outcome: AskUserOutput["outcome"]) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onAnswer(toolCallId, buildAskUserOutput(questions, drafts, outcome));
    },
    [drafts, onAnswer, questions, toolCallId],
  );

  const go = useCallback(
    (to: number) => {
      const clamped = Math.max(0, Math.min(questions.length - 1, to));
      setIndex(clamped);
      // Move focus to the body on navigation. Two reasons: screen readers
      // announce the new question, and the 1-9 and arrow shortcuts keep
      // working — leaving focus on a just-clicked arrow or on the free-text
      // box of the question we just left would swallow them.
      bodyRef.current?.focus();
    },
    [questions.length],
  );

  /** What the primary button does: advance, or submit on the last question. */
  const primary = useCallback(() => {
    // Guarded rather than relying on the button's `disabled`, since Enter
    // reaches this directly.
    if (!canAdvance) return;
    if (!isLast) {
      go(index + 1);
      return;
    }
    resolve("answered");
  }, [canAdvance, go, index, isLast, resolve]);

  const toggle = useCallback(
    (questionIndex: number, label: string) => {
      setDrafts((prev) =>
        prev.map((d, i) =>
          i === questionIndex
            ? applyOptionPick(d, questions[questionIndex], label)
            : d,
        ),
      );
      // Same focus rationale as `go`: the clicked option button would
      // otherwise keep focus and swallow Enter.
      bodyRef.current?.focus();
    },
    [questions],
  );

  const setOther = useCallback(
    (questionIndex: number, value: string) => {
      setDrafts((prev) =>
        prev.map((d, i) =>
          i === questionIndex
            ? applyOtherText(d, questions[questionIndex], value)
            : d,
        ),
      );
    },
    [questions],
  );

  // Grow the free-text box with its content up to the CSS `max-h`, past
  // which it scrolls. Re-measured on navigation too, since the box is
  // reused across questions and its content changes under it.
  useEffect(() => {
    const el = otherRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft.other, index]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const active = document.activeElement;
      const action = resolveQuestionKeyAction({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        inTextEntry:
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLElement && active.isContentEditable),
        onButton: active instanceof HTMLButtonElement,
        multi,
        optionCount: current.options.length,
      });
      if (action.kind === "ignore") return;
      e.preventDefault();
      switch (action.kind) {
        case "navigate":
          go(index + action.delta);
          return;
        case "primary":
          primary();
          return;
        case "dismiss":
          resolve("dismissed");
          return;
        case "pickOption":
          toggle(index, current.options[action.optionIndex].label);
          return;
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [current, go, index, multi, primary, resolve, toggle]);

  // Land focus in the body on mount so the shortcuts work without a click
  // and screen readers read the first question.
  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  const submitLabel = multi ? "Submit answers" : "Submit answer";
  // "Decide for me" didn't say WHAT it decided — on a paginated card it
  // read as though it might apply only to the question on screen. It
  // always resolves the whole call, so the label says so.
  const skipLabel = multi ? "Skip all questions" : "Skip this question";

  return (
    // Capped just short of the panel so a long question can use the whole
    // chat viewport. `overflow-hidden` + a scrolling body keeps the action
    // row pinned and reachable at any height.
    <div className="flex max-h-[calc(100vh-140px)] w-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <CircleHelp className="size-4 shrink-0 text-foreground" />
          <span className="text-sm font-medium">
            {multi
              ? `Question ${index + 1} of ${questions.length}`
              : "A question for you"}
          </span>

          {multi && (
            <div className="ml-auto flex items-center gap-2">
              {/* Pips double as progress and as direct navigation: filled
                  means answered, ringed means current. */}
              <div className="flex items-center gap-1">
                {drafts.map((d, i) => (
                  <button
                    key={questions[i].question}
                    type="button"
                    onClick={() => go(i)}
                    aria-label={`Question ${i + 1}: ${questions[i].header}${isQuestionAnswered(d) ? " (answered)" : ""}`}
                    aria-current={i === index}
                    className={cn(
                      "size-1.5 rounded-full transition-colors",
                      isQuestionAnswered(d) ? "bg-primary" : "bg-border",
                      i === index &&
                        "ring-2 ring-primary/40 ring-offset-1 ring-offset-card",
                    )}
                  />
                ))}
              </div>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => go(index - 1)}
                  disabled={index === 0}
                  aria-label="Previous question"
                  className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronLeft className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => go(index + 1)}
                  disabled={isLast}
                  aria-label="Next question"
                  className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          ref={bodyRef}
          tabIndex={-1}
          role={current.multiSelect ? "group" : "radiogroup"}
          aria-label={current.question}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3 outline-none"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
              {current.header}
            </span>
            {current.multiSelect && (
              <span className="text-[11px] leading-none text-muted-foreground">
                Pick any
              </span>
            )}
          </div>
          <div className="mb-2.5 text-sm leading-relaxed">
            {current.question}
          </div>

          <ul className="space-y-1">
            {current.options.map((option, oi) => {
              const checked = draft.selected.includes(option.label);
              return (
                <li key={option.label}>
                  <button
                    type="button"
                    role={current.multiSelect ? "checkbox" : "radio"}
                    aria-checked={checked}
                    onClick={() => toggle(index, option.label)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
                      checked
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center border text-primary-foreground",
                        current.multiSelect ? "rounded-sm" : "rounded-full",
                        checked ? "border-primary bg-primary" : "border-border",
                      )}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm leading-snug">
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {oi < 9 && <Kbd className="mt-0.5 shrink-0">{oi + 1}</Kbd>}
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Always present, never modelled by the tool schema — the model
              is told not to author an "Other" option. A textarea, not an
              input: a custom answer is often a sentence or two of context
              the options don't capture. The placeholder has to carry
              whether it replaces the picks or joins them, since that
              differs by `multiSelect` (see `applyOtherText`). */}
          <textarea
            ref={otherRef}
            rows={2}
            value={draft.other}
            onChange={(e) => setOther(index, e.target.value)}
            placeholder={
              current.multiSelect
                ? "Add your own answer"
                : "Or type your own answer"
            }
            aria-label={`Custom answer for: ${current.question}`}
            onKeyDown={(e) => {
              // Escape hands focus back to the body so the bare ← / →
              // shortcuts work again. Scoped to the textarea and stopped
              // here so it can't reach the panel-level Escape handler.
              if (e.key !== "Escape") return;
              e.stopPropagation();
              bodyRef.current?.focus();
            }}
            className="mt-2 max-h-[160px] w-full resize-none overflow-y-auto rounded-md border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none"
          />
          <p className="mt-1 text-[11px] leading-none text-muted-foreground">
            <Kbd>⇧⏎</Kbd> for a new line
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-1.5 border-t border-border px-4 py-3">
          <button
            type="button"
            data-action=""
            onClick={primary}
            disabled={!canAdvance}
            className="flex w-full items-center justify-between gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
          >
            <span>{isLast ? submitLabel : "Next question"}</span>
            <Kbd>⏎</Kbd>
          </button>
          <button
            type="button"
            onClick={() => resolve("dismissed")}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            <span>{skipLabel}</span>
            <Kbd>⌘⏎</Kbd>
          </button>
        </div>
      </div>

      <p className="mt-2 shrink-0 px-1 text-xs leading-relaxed text-muted-foreground">
        {multi
          ? "The agent is paused until you answer. Skipping discards every answer here and lets the agent proceed on its best interpretation — it will tell you what it assumed."
          : "The agent is paused until you answer. Skipping lets it proceed on its best interpretation — it will tell you what it assumed."}
      </p>
    </div>
  );
}
