/**
 * Pure helpers for rendering attachment chips.
 *
 * `getTypeBadge` and `formatBytes` are used in both the chat input
 * (preview) and the past-message rendering. `isTextFile` and
 * `countLines` are used at attach time to compute the "274 lines"
 * subtitle on the preview card.
 */

import { classifyFile } from "@/lib/vfs/file-classify";

const KB = 1024;
const MB = KB * 1024;

/**
 * A short uppercase label for the file's type, derived from its
 * extension. Used as the bottom-right pill on attachment cards.
 *
 * Examples: `report.pdf` → `PDF`, `app.tsx` → `TSX`,
 * `archive.tar.gz` → `GZ`, `README` → `FILE`, `.gitignore` → `FILE`
 * (dotfiles have no real extension).
 */
export function getTypeBadge(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return "FILE";
  const ext = filename.slice(lastDot + 1).toUpperCase();
  return ext || "FILE";
}

/**
 * True when classifyFile would tag this as text-like content (code or
 * markdown). Used to gate line-counting at attach time — counting
 * lines on a 50 MB binary is wasteful and meaningless.
 */
export function isTextFile(filename: string): boolean {
  const cls = classifyFile(filename);
  return cls === "code" || cls === "markdown";
}

/**
 * Count display-meaningful lines in a text body. Trailing newline
 * does not produce a phantom empty line — so `"abc\n"` is 1 line and
 * `"abc\ndef\n"` is 2, matching what most editors show.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  // Empty after trimming means a single "\n" with no content.
  if (trimmed.length === 0) return 1;
  return trimmed.split("\n").length;
}

/** Human-readable byte size. `26214` → `"26 KB"`, `5242880` → `"5.0 MB"`. */
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
