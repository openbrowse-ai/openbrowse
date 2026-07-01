import { describe, expect, it } from "vitest";
import type { AuditDbEntry } from "@/lib/mcp-bridge-audit-db";
import {
  buildListAuditMessage,
  deriveHostFilterOptions,
  formatOutcomeLabel,
} from "../AuditLogTable";

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

describe("AuditLogTable — buildListAuditMessage", () => {
  it("builds the base message with no options", () => {
    expect(buildListAuditMessage()).toEqual({ type: "MCP_BRIDGE_LIST_AUDIT" });
  });

  it("includes clientId when provided", () => {
    expect(buildListAuditMessage({ clientId: "c1" })).toEqual({
      type: "MCP_BRIDGE_LIST_AUDIT",
      clientId: "c1",
    });
  });

  it("includes limit when provided", () => {
    expect(buildListAuditMessage({ limit: 50 })).toEqual({
      type: "MCP_BRIDGE_LIST_AUDIT",
      limit: 50,
    });
  });

  it("includes both when both provided", () => {
    expect(buildListAuditMessage({ clientId: "c1", limit: 50 })).toEqual({
      type: "MCP_BRIDGE_LIST_AUDIT",
      clientId: "c1",
      limit: 50,
    });
  });

  it("omits clientId when an empty string is passed", () => {
    // Defensive: a "" clientId would be ambiguous on the background
    // side (interpret as "no filter" or filter by empty string?), so
    // we omit it from the wire message.
    expect(buildListAuditMessage({ clientId: "" })).toEqual({
      type: "MCP_BRIDGE_LIST_AUDIT",
    });
  });
});

describe("AuditLogTable — formatOutcomeLabel", () => {
  it("renders 'Success' for ok", () => {
    expect(formatOutcomeLabel("ok")).toBe("Success");
  });

  it("renders 'Error' for error", () => {
    expect(formatOutcomeLabel("error")).toBe("Error");
  });

  it("renders 'Denied' for denied", () => {
    expect(formatOutcomeLabel("denied")).toBe("Denied");
  });

  it("renders 'Rate limited' for rate_limited", () => {
    expect(formatOutcomeLabel("rate_limited")).toBe("Rate limited");
  });
});

describe("AuditLogTable — deriveHostFilterOptions", () => {
  it("returns an empty array for no entries", () => {
    expect(deriveHostFilterOptions([])).toEqual([]);
  });

  it("dedupes by clientId and preserves the latest hostName", () => {
    const entries: AuditDbEntry[] = [
      entry({ seq: 1, ts: 100, clientId: "c1", hostName: "Old" }),
      entry({ seq: 2, ts: 200, clientId: "c1", hostName: "New" }),
    ];
    expect(deriveHostFilterOptions(entries)).toEqual([
      { clientId: "c1", hostName: "New" },
    ]);
  });

  it("sorts alphabetically (case-insensitive) by hostName", () => {
    const entries: AuditDbEntry[] = [
      entry({ seq: 1, ts: 100, clientId: "c2", hostName: "Zed" }),
      entry({ seq: 2, ts: 100, clientId: "c1", hostName: "alpha" }),
      entry({ seq: 3, ts: 100, clientId: "c3", hostName: "Mid" }),
    ];
    expect(deriveHostFilterOptions(entries)).toEqual([
      { clientId: "c1", hostName: "alpha" },
      { clientId: "c3", hostName: "Mid" },
      { clientId: "c2", hostName: "Zed" },
    ]);
  });
});
