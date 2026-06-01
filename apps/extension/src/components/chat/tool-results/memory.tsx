import { Database } from "lucide-react";
import { HighlightedCode } from "./highlighted-code";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
  action: "save" | "update";
}

/**
 * Build a unified-diff-style string (lines prefixed with ` `, `+`, or `-`)
 * from old/new content using a longest-common-subsequence line diff. Unchanged
 * lines render as context; only genuine changes get +/- markers. Exported for
 * unit testing.
 */
export function buildMemoryDiff(oldContent: string, newContent: string): string {
  const a = oldContent.length ? oldContent.split("\n") : [];
  const b = newContent.length ? newContent.split("\n") : [];

  // LCS table (classic dynamic-programming line diff).
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) lines.push(`- ${a[i++]}`);
  while (j < n) lines.push(`+ ${b[j++]}`);

  return lines.join("\n");
}

/** All-additions diff for a brand-new memory. */
export function buildAdditionDiff(content: string): string {
  if (!content) return "";
  return content
    .split("\n")
    .map((l) => `+ ${l}`)
    .join("\n");
}

export function MemoryResult({ args, result, action }: Props) {
  const content = typeof args.content === "string" ? args.content : "";

  // Handle the "didn't happen" outcomes (e.g. update failed, save collided).
  const r = result as
    | { saved?: boolean; updated?: boolean; reason?: string; oldContent?: string; newContent?: string }
    | undefined;
  const failed =
    r != null &&
    ((action === "save" && r.saved === false) ||
      (action === "update" && r.updated === false));

  let diffText: string;
  if (action === "update" && typeof r?.oldContent === "string" && typeof r?.newContent === "string") {
    diffText = buildMemoryDiff(r.oldContent, r.newContent);
  } else {
    // Save (or update before result resolves): show the content as additions.
    diffText = buildAdditionDiff(content);
  }

  const title = typeof args.title === "string" ? args.title : undefined;
  const headerLabel = action === "save" ? "Memory saved" : "Memory updated";

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs font-mono">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <Database className="size-3 shrink-0" />
        <span className="truncate">
          {headerLabel}
          {title ? `: ${title}` : ""}
        </span>
      </div>
      {failed ? (
        <div className="px-3 py-2 bg-background/50 text-muted-foreground">
          {r?.reason ?? "No change made."}
        </div>
      ) : (
        <div className="px-3 py-2 bg-background/50 overflow-x-auto">
          <HighlightedCode code={diffText} lang="diff" maxLines={15} />
        </div>
      )}
    </div>
  );
}
