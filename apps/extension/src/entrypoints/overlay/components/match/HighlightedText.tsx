import type { Range } from "../../search/score";

interface HighlightedTextProps {
  text: string;
  ranges: Range[];
  className?: string;
}

/**
 * Render a string with the given character ranges bolded.
 * Ranges are assumed to be sorted and non-overlapping.
 */
export function HighlightedText({ text, ranges, className }: HighlightedTextProps) {
  if (!ranges.length) {
    return <span className={className}>{text}</span>;
  }
  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) {
      parts.push({ text: text.slice(cursor, start), highlighted: false });
    }
    if (end > start) {
      parts.push({ text: text.slice(start, end), highlighted: true });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false });
  }
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.highlighted ? (
          <span key={i} className="font-semibold text-foreground">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
