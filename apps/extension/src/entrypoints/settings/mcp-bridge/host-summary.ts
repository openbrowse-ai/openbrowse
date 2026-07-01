import type { AuditDbEntry } from "@/lib/mcp-bridge-audit-db";
import type { HostPolicy } from "@/lib/mcp-host-policy";

/**
 * One-row summary of a known MCP host: which clientId it presents, the
 * human-readable name we last saw it use, when it last called us, how
 * many calls we have on record (within the audit window), and the
 * effective policy the user has set.
 */
export interface HostSummary {
  clientId: string;
  clientName: string;
  lastSeenAt: number;
  callCount: number;
  policy: HostPolicy;
}

/**
 * Reduce a list of audit entries to one row per clientId, merging in
 * any user-set policies. Pure — no DB / chrome.* access — so this is
 * both reusable from the background message handler AND directly
 * unit-testable without IndexedDB or chrome.storage stubs.
 *
 * `audit` is expected to be the same shape we return from
 * `auditDb.list()`. Order does not matter; we keep the newest hostName
 * for each clientId, since hosts can change their display name over
 * time.
 */
export function summarizeHosts(
  audit: ReadonlyArray<AuditDbEntry>,
  policies: Readonly<Record<string, HostPolicy>>,
): HostSummary[] {
  const seen = new Map<
    string,
    { clientName: string; lastSeenAt: number; callCount: number }
  >();
  for (const e of audit) {
    const existing = seen.get(e.clientId);
    if (!existing) {
      seen.set(e.clientId, {
        clientName: e.hostName,
        lastSeenAt: e.ts,
        callCount: 1,
      });
      continue;
    }
    existing.callCount += 1;
    if (e.ts > existing.lastSeenAt) {
      // Newer entry wins for both timestamp and the displayed name.
      existing.lastSeenAt = e.ts;
      existing.clientName = e.hostName;
    }
  }
  return Array.from(seen.entries()).map(([clientId, summary]) => ({
    clientId,
    ...summary,
    policy: policies[clientId] ?? "always-prompt",
  }));
}

/**
 * Format an absolute epoch-ms timestamp as a short relative caption
 * ("just now", "5m ago", "3h ago", "2d ago"). Falls back to a
 * locale-formatted date for older entries.
 */
export function formatLastSeen(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(ts).toLocaleDateString();
}
