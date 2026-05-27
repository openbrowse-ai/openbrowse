import { useId, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Info,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { CompletionCheckRejectionData } from "@/lib/types";

/**
 * Three visual variants for the rejection block. The choice depends
 * on `data.reason` and `data.forceEmittedNext`; see {@link selectVariant}.
 *
 *  - `"evaluator-error"`: subtle gray informational note. The
 *    evaluator itself failed; the agent's response is unaffected, so
 *    we shouldn't alarm the user. No expand affordance, no concerns.
 *  - `"force-emit"`: soft warning. The gate caught real issues that
 *    were NOT resolved (loop hit budget). Worth surfacing prominently.
 *  - `"refining"`: neutral. The gate caught issues mid-loop and the
 *    agent revised. By the time the user sees this rendered, the
 *    revised response is also visible — this block is the audit
 *    trail showing the agent self-corrected. Compact by default.
 */
type Variant = "evaluator-error" | "force-emit" | "refining";

/**
 * Pure decision: which variant to render.
 *
 * Exported for unit tests; rendering logic stays manual.
 */
export function selectVariant(data: CompletionCheckRejectionData): Variant {
  if (data.reason === "evaluator-error") return "evaluator-error";
  if (data.forceEmittedNext) return "force-emit";
  return "refining";
}

/**
 * Pure formatting: the heading text shown in the collapsed pill.
 *
 * "issue" / "issues" pluralize for `refining`. `force-emit` uses
 * "flagged" because "issues" with a warning icon doubles the warning
 * voice. `evaluator-error` uses a fixed string.
 *
 * Exported for unit tests.
 */
export function selectHeading(
  variant: Variant,
  concernCount: number,
): string {
  switch (variant) {
    case "evaluator-error":
      return "Quality check skipped — evaluator could not complete.";
    case "force-emit":
      return `This response may have issues (${concernCount} flagged)`;
    case "refining": {
      const noun = concernCount === 1 ? "issue" : "issues";
      return `Refining answer (${concernCount} ${noun})`;
    }
  }
}

/**
 * Renders a `data-completion-check-rejection` part as an inline
 * audit-trail block within an assistant message.
 *
 * UX principles for this block:
 *
 *  - **No internal jargon inline.** Dimension labels (`completeness`,
 *    `surfaceAccuracy`, etc.), evidence quotes, and the reasoning
 *    paragraph are all internal scaffolding the user doesn't need.
 *    Each concern surfaces only its `userSummary` — a one-sentence
 *    plain-language observation produced by the evaluator.
 *  - **Default collapsed.** The block lives in the message scrollback;
 *    expanded-by-default would mean every refined turn dumps a wall
 *    of text on every render.
 *  - **Tiered intensity.** Mid-loop refinements (most common case)
 *    are neutral — the agent self-corrected. Force-emits are warning-
 *    colored because the user actually needs to know the answer might
 *    be wrong. Evaluator errors are gray because nothing the user
 *    sees is affected.
 *
 * The full technical detail (dimensions, evidence, reasoning, follow-up
 * sent to the agent) is preserved in the markdown export — see
 * `lib/format-markdown.ts`.
 */
export function CompletionCheckBlock({
  data,
}: {
  data: CompletionCheckRejectionData;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const variant = selectVariant(data);

  // Evaluator-error variant: minimal, non-interactive note. No
  // concerns to surface, no expansion affordance.
  if (variant === "evaluator-error") {
    return (
      <div
        className="my-2 flex items-center gap-1.5 rounded-md border border-muted-foreground/20 bg-muted/30 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground"
        data-testid="completion-check-block"
        data-variant="evaluator-error"
      >
        <Info className="size-3 shrink-0" />
        <span>{selectHeading(variant, data.concerns.length)}</span>
      </div>
    );
  }

  const isForceEmit = variant === "force-emit";
  const palette = isForceEmit
    ? "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300"
    : "border-muted-foreground/20 bg-muted/30 text-muted-foreground";
  const Icon = isForceEmit ? TriangleAlert : Sparkles;

  return (
    <div
      className={`my-2 rounded-md border ${palette} text-xs`}
      data-testid="completion-check-block"
      data-variant={variant}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <Icon className="size-3.5 shrink-0" />
        <span className="flex-1 font-medium">
          {selectHeading(variant, data.concerns.length)}
        </span>
      </button>
      {expanded && (
        <div
          id={bodyId}
          className="border-t border-current/15 px-2.5 py-2"
        >
          <ul className="space-y-1 leading-relaxed">
            {data.concerns.map((c, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="opacity-50 shrink-0">•</span>
                <span>{c.userSummary}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
