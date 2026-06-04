// src/lib/schedule/format.test.ts
import { describe, expect, it } from "vitest";
import { formatSchedule, formatRelativeTime } from "./format";

describe("formatSchedule", () => {
  it("manual", () => {
    expect(formatSchedule({ kind: "manual" })).toBe("Manual");
  });
  it("hourly", () => {
    expect(formatSchedule({ kind: "hourly", minute: 0 })).toBe(
      "Hourly at :00",
    );
    expect(formatSchedule({ kind: "hourly", minute: 5 })).toBe(
      "Hourly at :05",
    );
  });
  it("daily", () => {
    expect(formatSchedule({ kind: "daily", hour: 9, minute: 0 })).toBe(
      "Daily at 09:00",
    );
  });
  it("weekdays", () => {
    expect(formatSchedule({ kind: "weekdays", hour: 8, minute: 30 })).toBe(
      "Weekdays at 08:30",
    );
  });
  it("weekly", () => {
    expect(
      formatSchedule({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }),
    ).toBe("Weekly on Monday at 09:00");
  });
  it("once", () => {
    // Just assert it starts with "Once on" — exact date string is locale-dependent.
    const out = formatSchedule({ kind: "once", at: Date.now() });
    expect(out.startsWith("Once on ")).toBe(true);
  });
});

describe("formatRelativeTime", () => {
  const now = 1_000_000_000_000;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;

  it("'soon' for under a minute away", () => {
    expect(formatRelativeTime(now + 30_000, now)).toBe("soon");
    expect(formatRelativeTime(now + min - 1, now)).toBe("soon");
  });

  it("minutes", () => {
    expect(formatRelativeTime(now + 5 * min, now)).toBe("in 5 minutes");
    expect(formatRelativeTime(now + 1 * min, now)).toBe("in 1 minute");
  });

  it("hours", () => {
    expect(formatRelativeTime(now + 3 * hr, now)).toBe("in 3 hours");
    expect(formatRelativeTime(now + 1 * hr, now)).toBe("in 1 hour");
  });

  it("days", () => {
    expect(formatRelativeTime(now + 2 * day, now)).toBe("in 2 days");
    expect(formatRelativeTime(now + 1 * day, now)).toBe("in 1 day");
  });

  it("past times read as 'soon' (never negative)", () => {
    expect(formatRelativeTime(now - 5 * min, now)).toBe("soon");
  });
});

