import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";

beforeEach(() => {
  // Fresh IDB world per test:
  (globalThis as any).indexedDB = new (globalThis as any).IDBFactory();
});

afterEach(async () => {
  const { auditDb } = await import("@/lib/mcp-bridge-audit-db");
  auditDb._resetForTests();
  vi.resetModules();
});

describe("mcp-bridge-audit-db", () => {
  it("appends and lists entries newest-first", async () => {
    const { auditDb } = await import("@/lib/mcp-bridge-audit-db");
    const now = Date.now();
    await auditDb.append({ seq: 1, ts: now - 1000, clientId: "c1", hostName: "Cursor", method: "read_page", durationMs: 10, outcome: "ok" });
    await auditDb.append({ seq: 2, ts: now, clientId: "c1", hostName: "Cursor", method: "screenshot", durationMs: 200, outcome: "ok" });
    const list = await auditDb.list();
    expect(list.map((e) => e.method)).toEqual(["screenshot", "read_page"]);
  });

  it("filters by clientId", async () => {
    const { auditDb } = await import("@/lib/mcp-bridge-audit-db");
    const now = Date.now();
    await auditDb.append({ seq: 1, ts: now, clientId: "c1", hostName: "h1", method: "read_page", durationMs: 1, outcome: "ok" });
    await auditDb.append({ seq: 2, ts: now, clientId: "c2", hostName: "h2", method: "read_page", durationMs: 1, outcome: "ok" });
    const c1 = await auditDb.list({ clientId: "c1" });
    expect(c1).toHaveLength(1);
    expect(c1[0].clientId).toBe("c1");
  });

  it("clearOlderThan removes pre-cutoff entries", async () => {
    const { auditDb } = await import("@/lib/mcp-bridge-audit-db");
    const now = Date.now();
    await auditDb.append({ seq: 1, ts: now - 5000, clientId: "c1", hostName: "h", method: "x", durationMs: 1, outcome: "ok" });
    await auditDb.append({ seq: 2, ts: now, clientId: "c1", hostName: "h", method: "x", durationMs: 1, outcome: "ok" });
    await auditDb.clearOlderThan(now - 2000);
    const list = await auditDb.list();
    expect(list.map((e) => e.seq)).toEqual([2]);
  });
});
