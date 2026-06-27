/**
 * Host allowlist matching for the brokered `openbrowse.network.fetch` bridge.
 *
 * An artifact declares the hosts it may reach in `manifest.network[]`; the user
 * approves them at install time. Entries are either:
 *   - an exact host: `example.com` matches only `example.com`
 *   - a wildcard:     `*.example.com` matches any subdomain (`api.example.com`,
 *                     `a.b.example.com`) but NOT the bare `example.com`
 *
 * Matching is case-insensitive. Invalid input returns false.
 */
export function isHostAllowed(host: string, allowlist: string[]): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const entry = raw.toLowerCase();
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(2); // drop "*."
      if (suffix.length === 0) continue;
      // Require at least one label before the suffix: a.suffix, not suffix.
      if (h.length > suffix.length && h.endsWith("." + suffix)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}
