/**
 * Token splitting for queries and search targets.
 *
 * Splits on whitespace, slashes, dashes, dots, underscores, query punctuation,
 * and empty groups. Returns lowercased tokens with empty strings filtered out.
 */
const TOKEN_SPLIT = /[\s\-_./?#=&:;,!@()[\]{}<>"'`~]+/;

export function tokens(input: string): string[] {
  if (!input) return [];
  return input
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0);
}

/**
 * Find the start index of `needle` in `haystack` after lowercasing both.
 * Returns -1 if not present.
 */
export function caseInsensitiveIndexOf(haystack: string, needle: string, fromIndex = 0): number {
  if (!needle) return -1;
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), fromIndex);
}

/**
 * Locate the host substring boundaries inside a URL string. Returns the
 * [start, end) indices of the hostname inside the original URL, or null if
 * the URL cannot be parsed.
 */
export function hostBoundsInUrl(url: string): [number, number] | null {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (!host) return null;
    const lower = url.toLowerCase();
    const idx = lower.indexOf(host.toLowerCase());
    if (idx < 0) return null;
    return [idx, idx + host.length];
  } catch {
    return null;
  }
}
