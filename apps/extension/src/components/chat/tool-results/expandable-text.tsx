import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface ExpandableTextProps {
  text: string;
  /**
   * Soft cap on visible lines when collapsed. Both `\n`-delimited lines
   * and visually-wrapped long lines count: a 1-line, 600-character
   * tool error wraps to ~7-8 visual lines at typical chat width and
   * still gets clamped (without this rule, a single long line never
   * collapsed because `text.split("\n").length === 1`).
   */
  maxLines?: number;
  className?: string;
}

/**
 * Approximate column width used to estimate the number of visual lines
 * a single long string will wrap to. Tool error messages render in the
 * chat at roughly this width with the current font/size — close enough
 * for a clamp threshold; we don't need pixel-perfect measurement.
 */
export const ESTIMATED_CHARS_PER_VISUAL_LINE = 80;

/**
 * Estimate how many visual lines `text` will occupy at the given column
 * width, treating `\n` as a hard wrap and assuming naive whole-character
 * wrapping for the rest. Always returns at least 1 (empty strings still
 * occupy a line of layout).
 *
 * Exported for unit tests.
 */
export function estimateVisualLines(
  text: string,
  charsPerLine: number = ESTIMATED_CHARS_PER_VISUAL_LINE,
): number {
  // Per the contract above, even an empty string occupies one line of
  // layout. The split below produces `[""]` for empty input, the loop
  // runs once, and `Math.max(1, …)` yields 1 — so we don't need a
  // dedicated empty-string branch. Callers that want zero rows for
  // empty input should short-circuit at the call site (see
  // `ExpandableText` itself, which returns `null` before calling).
  const lines = text.split("\n");
  let total = 0;
  for (const line of lines) {
    // Each \n-delimited segment occupies at least one visual line, even
    // if empty (preserves blank-line spacing in the rendered <pre>).
    total += Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  return total;
}

export function ExpandableText({
  text,
  maxLines = 10,
  className,
}: ExpandableTextProps) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  const lines = text.split("\n");
  const visualLines = estimateVisualLines(text);
  const isExpandable = visualLines > maxLines;

  // When collapsed, prefer slicing on `\n` boundaries when there are
  // enough of them; fall back to a character slice for the
  // single-long-line case so we never render the full string when the
  // clamp wants to hide content.
  let displayText: string;
  if (!isExpandable || expanded) {
    displayText = text;
  } else if (lines.length > maxLines) {
    displayText = lines.slice(0, maxLines).join("\n");
  } else {
    const sliceChars = maxLines * ESTIMATED_CHARS_PER_VISUAL_LINE;
    displayText = text.slice(0, sliceChars);
  }

  // Toggle label depends on which clamp branch fired. Newline-bounded
  // collapse can give an exact "Show N more lines" count; the single-
  // long-line case has no meaningful line count, so use a generic
  // label.
  const showMoreLabel =
    lines.length > maxLines
      ? `Show ${lines.length - maxLines} more lines`
      : "Show full output";

  return (
    <div className="relative group">
      <pre className={cn("whitespace-pre-wrap", className)}>
        {displayText}
      </pre>
      {isExpandable && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground text-[10px] mt-1.5 flex items-center gap-1 font-sans transition-colors cursor-pointer select-none"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="size-3" /> {showMoreLabel}
            </>
          )}
        </button>
      )}
    </div>
  );
}
