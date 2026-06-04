// src/lib/schedule/next-run.test.ts
import { describe, expect, it } from "vitest";
import { computeNextRun } from "./next-run";

// Helper: local Date → epoch ms. Tests run in the host TZ; we assert
// relationships (strictly-after, correct wall-clock fields) rather than
// hard-coded UTC values so they pass in any timezone.
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo, d, h, mi, 0, 0).getTime();
}

describe("computeNextRun", () => {
  it("returns null for manual", () => {
    expect(computeNextRun({ kind: "manual" }, at(2026, 0, 1, 9, 0))).toBeNull();
  });

  it("returns future 'once' as-is", () => {
    const future = at(2026, 0, 2, 9, 0);
    expect(
      computeNextRun({ kind: "once", at: future }, at(2026, 0, 1, 9, 0)),
    ).toBe(future);
  });

  it("returns null for past 'once'", () => {
    const past = at(2026, 0, 1, 8, 0);
    expect(
      computeNextRun({ kind: "once", at: past }, at(2026, 0, 1, 9, 0)),
    ).toBeNull();
  });

  it("hourly: next occurrence of the given minute, strictly after now", () => {
    const now = at(2026, 0, 1, 9, 30);
    const next = computeNextRun({ kind: "hourly", minute: 15 }, now)!;
    const d = new Date(next);
    expect(d.getMinutes()).toBe(15);
    expect(next).toBeGreaterThan(now);
    expect(next - now).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("hourly: when now is before the minute this hour, uses this hour", () => {
    const now = at(2026, 0, 1, 9, 10);
    const next = computeNextRun({ kind: "hourly", minute: 15 }, now)!;
    expect(next).toBe(at(2026, 0, 1, 9, 15));
  });

  it("daily: same day if time is later", () => {
    const now = at(2026, 0, 1, 7, 0);
    const next = computeNextRun({ kind: "daily", hour: 9, minute: 0 }, now)!;
    expect(next).toBe(at(2026, 0, 1, 9, 0));
  });

  it("daily: next day if time already passed", () => {
    const now = at(2026, 0, 1, 9, 1);
    const next = computeNextRun({ kind: "daily", hour: 9, minute: 0 }, now)!;
    expect(next).toBe(at(2026, 0, 2, 9, 0));
  });

  it("daily: exactly at the minute rolls to next day (strictly after)", () => {
    const now = at(2026, 0, 1, 9, 0);
    const next = computeNextRun({ kind: "daily", hour: 9, minute: 0 }, now)!;
    expect(next).toBe(at(2026, 0, 2, 9, 0));
  });

  it("weekdays: skips weekend", () => {
    // 2026-01-03 is a Saturday; 2026-01-04 Sunday; next weekday is Mon 01-05.
    const sat = at(2026, 0, 3, 7, 0);
    const next = computeNextRun({ kind: "weekdays", hour: 9, minute: 0 }, sat)!;
    expect(next).toBe(at(2026, 0, 5, 9, 0));
  });

  it("weekly: next matching weekday", () => {
    // 2026-01-01 is a Thursday (weekday 4). Target Monday (1).
    const thu = at(2026, 0, 1, 9, 0);
    const next = computeNextRun(
      { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
      thu,
    )!;
    expect(new Date(next).getDay()).toBe(1);
    expect(next).toBe(at(2026, 0, 5, 9, 0));
  });

  it("weekly: same weekday but later today uses today", () => {
    const thu = at(2026, 0, 1, 7, 0); // Thursday, weekday 4
    const next = computeNextRun(
      { kind: "weekly", weekday: 4, hour: 9, minute: 0 },
      thu,
    )!;
    expect(next).toBe(at(2026, 0, 1, 9, 0));
  });

  it("weekly: same weekday already passed rolls 7 days", () => {
    const thu = at(2026, 0, 1, 9, 1); // Thursday, weekday 4, past 09:00
    const next = computeNextRun(
      { kind: "weekly", weekday: 4, hour: 9, minute: 0 },
      thu,
    )!;
    expect(next).toBe(at(2026, 0, 8, 9, 0));
  });
});
