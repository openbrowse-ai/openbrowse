import { useState } from "react";
import { ChevronDown, ChevronUp, Scissors } from "lucide-react";
import { Markdown } from "./Markdown";

interface CompactionDividerProps {
  /**
   * Plain-text summary that the LLM sees in place of the compacted head.
   * Empty string is acceptable (e.g. if the compaction was triggered by a
   * pruning-only fast path with no LLM-generated narrative).
   */
  summary: string;
  /** Number of messages that came before the compaction boundary. */
  hiddenCount: number;
  /** True when the compaction was auto-triggered by the token threshold. */
  auto: boolean;
  /** True when triggered by a context-overflow API error path. */
  overflow?: boolean;
}

/**
 * Visual marker shown in the chat stream where the conversation was
 * compacted. The full message history remains in the UI; this divider
 * indicates which messages have been replaced by a summary in what gets
 * sent to the model.
 *
 * Click the band to expand and read the summary that the LLM now sees in
 * place of the compacted head.
 *
 * The same component renders for every trigger source (auto post-turn,
 * mid-stream, manual /compact, overflow recovery) — only the small
 * subtitle next to the count changes, so users always see a consistent
 * UI.
 */
export function CompactionDivider({
  summary,
  hiddenCount,
  auto,
  overflow,
}: CompactionDividerProps) {
  const [expanded, setExpanded] = useState(false);
  const countLabel =
    hiddenCount === 1
      ? "Compacted 1 earlier message"
      : `Compacted ${hiddenCount} earlier messages`;
  const reasonLabel = overflow
    ? "context overflow"
    : auto
      ? "auto"
      : "manual";
  const hasSummary = summary.trim().length > 0;

  return (
    <div className="my-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-2 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={expanded}
        aria-label={
          expanded ? "Hide compaction summary" : "Show compaction summary"
        }
      >
        <div className="h-px flex-1 bg-border transition-colors group-hover:bg-foreground/30" />
        <Scissors className="size-3 shrink-0" />
        <span className="whitespace-nowrap">
          {countLabel} <span className="opacity-60">({reasonLabel})</span>
        </span>
        {expanded ? (
          <ChevronUp className="size-3 shrink-0" />
        ) : (
          <ChevronDown className="size-3 shrink-0" />
        )}
        <div className="h-px flex-1 bg-border transition-colors group-hover:bg-foreground/30" />
      </button>
      {expanded && (
        <div className="mt-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Summary sent to the model
          </div>
          {hasSummary ? (
            <Markdown
              source={summary}
              className="text-xs [&_h2]:!text-xs [&_h2]:!font-semibold [&_h2]:!mt-2 [&_h2]:!mb-1 [&_ul]:!my-1 [&_p]:!my-1"
            />
          ) : (
            <p className="italic text-muted-foreground/70">
              No summary text — the head was reduced by pruning oversized
              tool outputs only.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
