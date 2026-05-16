/**
 * URL canonicalization for dedup across sources (tabs, history, bookmarks, etc.).
 *
 * Mirrors Chrome's `GURLToStrippedGURL` minimally:
 * - lowercase hostname
 * - drop leading `www.` and `m.`
 * - drop trailing slash on path
 * - drop URL fragment
 * - drop default ports (http:80, https:443)
 *
 * Two distinct URLs that differ only in these dimensions collapse to the same key.
 */
export function canonicalUrl(raw: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    const port =
      (u.protocol === "http:" && u.port === "80") ||
      (u.protocol === "https:" && u.port === "443")
        ? ""
        : u.port
          ? `:${u.port}`
          : "";
    return `${host}${port}${path}${u.search}`;
  } catch {
    return raw.toLowerCase();
  }
}
