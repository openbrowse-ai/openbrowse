import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditDbEntry } from "@/lib/mcp-bridge-audit-db";
import { formatActionLabel, formatOutcomeLabel } from "./action-labels";

/**
 * Pure helper, exported for unit testing: shapes the
 * `MCP_BRIDGE_LIST_AUDIT` request message.
 */
export function buildListAuditMessage(
  opts: { clientId?: string; limit?: number } = {},
): { type: "MCP_BRIDGE_LIST_AUDIT"; clientId?: string; limit?: number } {
  const msg: {
    type: "MCP_BRIDGE_LIST_AUDIT";
    clientId?: string;
    limit?: number;
  } = { type: "MCP_BRIDGE_LIST_AUDIT" };
  if (opts.clientId) msg.clientId = opts.clientId;
  if (opts.limit !== undefined) msg.limit = opts.limit;
  return msg;
}

// Re-export the action / outcome formatters so existing callers /
// tests can import from this module verbatim. The implementations
// moved to `action-labels.ts` for re-use by other surfaces.
export { formatActionLabel, formatOutcomeLabel };

/**
 * Pure helper, exported for unit testing: derive the unique set of
 * MCP clients observed in the audit entries.
 */
export function deriveHostFilterOptions(
  entries: ReadonlyArray<AuditDbEntry>,
): Array<{ clientId: string; hostName: string }> {
  const byClient = new Map<string, { hostName: string; ts: number }>();
  for (const e of entries) {
    const existing = byClient.get(e.clientId);
    if (!existing || e.ts > existing.ts) {
      byClient.set(e.clientId, { hostName: e.hostName, ts: e.ts });
    }
  }
  return Array.from(byClient.entries())
    .map(([clientId, { hostName }]) => ({ clientId, hostName }))
    .sort((a, b) => a.hostName.toLowerCase().localeCompare(b.hostName.toLowerCase()));
}

const PAGE_SIZE = 100;

interface ListAuditResponse {
  ok: boolean;
  entries?: AuditDbEntry[];
  error?: string;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function AuditLogTable() {
  const [entries, setEntries] = useState<AuditDbEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostFilter, setHostFilter] = useState<string>("");
  // Track expanded rows by `seq` so error rows can disclose the raw
  // method name + error code in a single click. Most rows aren't
  // expanded most of the time so a Set is the natural fit.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const resp = (await chrome.runtime.sendMessage(
        buildListAuditMessage({ limit: PAGE_SIZE }),
      )) as ListAuditResponse;
      if (!resp?.ok) {
        setError(resp?.error ?? "Failed to load logs");
        return;
      }
      setError(null);
      setEntries(resp.entries ?? []);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hostOptions = useMemo(
    () => deriveHostFilterOptions(entries ?? []),
    [entries],
  );

  const filtered = useMemo(() => {
    if (!entries) return null;
    if (!hostFilter) return entries;
    return entries.filter((e) => e.clientId === hostFilter);
  }, [entries, hostFilter]);

  function toggle(seq: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }

  if (error) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        Couldn't load MCP logs: {error}
      </div>
    );
  }

  if (entries === null) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (entries.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No MCP activity logged yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <label htmlFor="audit-host-filter" className="text-muted-foreground">
          Filter by MCP client:
        </label>
        <select
          id="audit-host-filter"
          value={hostFilter}
          onChange={(e) => setHostFilter(e.target.value)}
          className="rounded border border-border bg-background px-2 py-1"
        >
          <option value="">All MCP clients</option>
          {hostOptions.map((h) => (
            <option key={h.clientId} value={h.clientId}>
              {h.hostName}
            </option>
          ))}
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <th className="py-2 pr-3 font-medium">When</th>
              <th className="py-2 pr-3 font-medium">MCP client</th>
              <th className="py-2 pr-3 font-medium">Action</th>
              <th className="py-2 pr-3 font-medium">Outcome</th>
              <th className="py-2 font-medium">Duration</th>
            </tr>
          </thead>
          <tbody>
            {(filtered ?? []).flatMap((e) => {
              const isExpandable =
                e.outcome === "error" || e.outcome === "denied" || !!e.errorCode;
              const isExpanded = expanded.has(e.seq);
              const rows = [
                <tr
                  key={e.seq}
                  className={`border-b border-border/50 last:border-b-0 ${
                    isExpandable ? "cursor-pointer hover:bg-accent/30" : ""
                  }`}
                  onClick={isExpandable ? () => toggle(e.seq) : undefined}
                >
                  <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                    {formatTimestamp(e.ts)}
                  </td>
                  <td className="py-2 pr-3">{e.hostName}</td>
                  <td className="py-2 pr-3">{formatActionLabel(e.method)}</td>
                  <td className="py-2 pr-3">{formatOutcomeLabel(e.outcome)}</td>
                  <td className="py-2 tabular-nums">{e.durationMs}ms</td>
                </tr>,
              ];
              if (isExpandable && isExpanded) {
                rows.push(
                  <tr
                    key={`${e.seq}-detail`}
                    className="border-b border-border/50 bg-muted/30"
                  >
                    <td colSpan={5} className="py-2 pr-3 text-xs">
                      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
                        <dt className="text-muted-foreground">Raw method</dt>
                        <dd className="font-mono">{e.method}</dd>
                        {e.errorCode && (
                          <>
                            <dt className="text-muted-foreground">Error code</dt>
                            <dd className="font-mono">{e.errorCode}</dd>
                          </>
                        )}
                      </dl>
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
