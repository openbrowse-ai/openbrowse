/**
 * Build a unified-diff-style string (lines prefixed with ` `, `+`, or `-`)
 * from old/new content using a longest-common-subsequence line diff. Unchanged
 * lines render as context; only genuine changes get +/- markers.
 *
 * Shared between the `updateMemory` tool (which computes the preview at execute
 * time so the tool result stays lightweight) and the `MemoryResult` renderer.
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
