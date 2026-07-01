import { describe, expect, it } from "vitest";
import type { AuditDbEntry } from "@/lib/mcp-bridge-audit-db";
import {
  buildListHostsMessage,
  buildRevokeMessage,
} from "../HostsList";
import { formatLastSeen, summarizeHosts } from "../host-summary";

function entry(
  partial: Partial<AuditDbEntry> & { seq: number; ts: number; clientId: string },
): AuditDbEntry {
  return {
    hostName: `host-${partial.clientId}`,
    method: "rpc.dispatchTask",
    durationMs: 0,
    outcome: "ok",
    ...partial,
  };
}

describe("HostsList — buildListHostsMessage", () => {
  it("builds the list-hosts request message", () => {
    expect(buildListHostsMessage()).toEqual({ type: "MCP_BRIDGE_LIST_HOSTS" });
  });
});

describe("HostsList — buildRevokeMessage", () => {
  it("builds the revoke-host message for a clientId", () => {
    expect(buildRevokeMessage("c1")).toEqual({
      type: "MCP_BRIDGE_REVOKE_HOST",
      clientId: "c1",
    });
  });
});

describe("summarizeHosts", () => {
  it("returns an empty array for an empty audit log", () => {
    expect(summarizeHosts([], {})).toEqual([]);
  });

  it("groups entries by clientId and counts calls", () => {
    const audit: AuditDbEntry[] = [
      entry({ seq: 1, ts: 100, clientId: "c1", hostName: "First" }),
      entry({ seq: 2, ts: 200, clientId: "c1", hostName: "First v2" }),
      entry({ seq: 3, ts: 150, clientId: "c2", hostName: "Second" }),
    ];
    const out = summarizeHosts(audit, {});
    // sort by clientId for a stable assertion since summarizeHosts
    // doesn't promise any particular order.
    out.sort((a, b) => a.clientId.localeCompare(b.clientId));
    expect(out).toEqual([
      {
        clientId: "c1",
        clientName: "First v2",
        lastSeenAt: 200,
        callCount: 2,
        policy: "always-prompt",
      },
      {
        clientId: "c2",
        clientName: "Second",
        lastSeenAt: 150,
        callCount: 1,
        policy: "always-prompt",
      },
    ]);
  });

  it("keeps the hostName from the newest entry per clientId", () => {
    // Out-of-order audit entries (older comes after newer); the
    // newer-timestamp hostName should still win.
    const audit: AuditDbEntry[] = [
      entry({ seq: 1, ts: 500, clientId: "c1", hostName: "Newer" }),
      entry({ seq: 2, ts: 100, clientId: "c1", hostName: "Older" }),
    ];
    const [row] = summarizeHosts(audit, {});
    expect(row.clientName).toBe("Newer");
    expect(row.lastSeenAt).toBe(500);
    expect(row.callCount).toBe(2);
  });

  it("merges in policy overrides, defaulting to always-prompt", () => {
    const audit: AuditDbEntry[] = [
      entry({ seq: 1, ts: 100, clientId: "c1" }),
      entry({ seq: 2, ts: 100, clientId: "c2" }),
      entry({ seq: 3, ts: 100, clientId: "c3" }),
    ];
    const out = summarizeHosts(audit, {
      c1: "auto-allow",
      c2: "blocked",
      // c3 omitted → default
    });
    const byId = Object.fromEntries(out.map((r) => [r.clientId, r.policy]));
    expect(byId).toEqual({
      c1: "auto-allow",
      c2: "blocked",
      c3: "always-prompt",
    });
  });
});

describe("formatLastSeen", () => {
  const NOW = 1_700_000_000_000;
  it("renders 'just now' for sub-minute deltas", () => {
    expect(formatLastSeen(NOW - 5_000, NOW)).toBe("just now");
    expect(formatLastSeen(NOW - 59_999, NOW)).toBe("just now");
  });

  it("renders minutes for sub-hour deltas", () => {
    expect(formatLastSeen(NOW - 60_000, NOW)).toBe("1m ago");
    expect(formatLastSeen(NOW - 30 * 60_000, NOW)).toBe("30m ago");
  });

  it("renders hours for sub-day deltas", () => {
    expect(formatLastSeen(NOW - 60 * 60_000, NOW)).toBe("1h ago");
    expect(formatLastSeen(NOW - 23 * 60 * 60_000, NOW)).toBe("23h ago");
  });

  it("renders days up to 30 days", () => {
    const DAY = 24 * 60 * 60_000;
    expect(formatLastSeen(NOW - DAY, NOW)).toBe("1d ago");
    expect(formatLastSeen(NOW - 29 * DAY, NOW)).toBe("29d ago");
  });

  it("falls back to a locale date string past 30 days", () => {
    const DAY = 24 * 60 * 60_000;
    const ts = NOW - 31 * DAY;
    const out = formatLastSeen(ts, NOW);
    // We don't pin the exact format — just that it doesn't claim a
    // recent relative time anymore.
    expect(out).not.toMatch(/ago$/);
    expect(out).toBe(new Date(ts).toLocaleDateString());
  });

  it("clamps negative deltas (clock skew) to 'just now'", () => {
    expect(formatLastSeen(NOW + 5_000, NOW)).toBe("just now");
  });
});
