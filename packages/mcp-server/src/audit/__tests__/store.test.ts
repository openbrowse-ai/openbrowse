import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("audit/store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T00:00:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("records and lists entries in insertion order", async () => {
    const { createAuditStore } = await import("../store");
    const store = createAuditStore(256);
    store.append({ clientId: "c1", hostName: "Cursor", method: "read_page", durationMs: 12, outcome: "ok" });
    store.append({ clientId: "c1", hostName: "Cursor", method: "screenshot", durationMs: 200, outcome: "ok" });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].method).toBe("read_page");
    expect(list[1].method).toBe("screenshot");
  });

  it("drops oldest entries when capacity is exceeded (ring)", async () => {
    const { createAuditStore } = await import("../store");
    const store = createAuditStore(3);
    for (let i = 0; i < 5; i++) {
      store.append({ clientId: "c1", hostName: "h", method: "read_page", durationMs: 1, outcome: "ok" });
    }
    expect(store.list()).toHaveLength(3);
  });

  it("stamps each entry with a timestamp and monotonic id", async () => {
    const { createAuditStore } = await import("../store");
    const store = createAuditStore(8);
    store.append({ clientId: "c1", hostName: "h", method: "read_page", durationMs: 1, outcome: "ok" });
    vi.advanceTimersByTime(1000);
    store.append({ clientId: "c1", hostName: "h", method: "read_page", durationMs: 1, outcome: "ok" });
    const list = store.list();
    expect(list[0].ts).toBe(new Date("2026-06-26T00:00:00Z").getTime());
    expect(list[1].ts).toBe(new Date("2026-06-26T00:00:01Z").getTime());
    expect(list[1].seq).toBeGreaterThan(list[0].seq);
  });
});
