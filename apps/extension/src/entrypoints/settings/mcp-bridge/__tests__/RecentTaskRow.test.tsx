import { describe, expect, it } from "vitest";
import { formatCompletedAt } from "../RecentTaskRow";

// Note: `buildOpenConversationHash` and `buildOpenConversationUrl`
// moved to `../open-conversation` so `ActiveTaskCard` can share them.
// Their tests now live in `open-conversation.test.ts`.

describe("RecentTaskRow — formatCompletedAt", () => {
  const NOW = 1_700_000_000_000;

  it("renders 'just now' for sub-minute deltas", () => {
    expect(formatCompletedAt(NOW - 5_000, NOW)).toBe("just now");
    expect(formatCompletedAt(NOW - 59_999, NOW)).toBe("just now");
  });

  it("renders 'X min ago' for sub-hour deltas", () => {
    expect(formatCompletedAt(NOW - 60_000, NOW)).toBe("1 min ago");
    expect(formatCompletedAt(NOW - 30 * 60_000, NOW)).toBe("30 min ago");
  });

  it("renders 'Xh ago' for sub-day deltas", () => {
    expect(formatCompletedAt(NOW - 60 * 60_000, NOW)).toBe("1h ago");
    expect(formatCompletedAt(NOW - 23 * 60 * 60_000, NOW)).toBe("23h ago");
  });

  it("renders 'Xd ago' up to 7 days", () => {
    const DAY = 24 * 60 * 60_000;
    expect(formatCompletedAt(NOW - DAY, NOW)).toBe("1d ago");
    expect(formatCompletedAt(NOW - 6 * DAY, NOW)).toBe("6d ago");
  });

  it("falls back to a locale date string past 7 days", () => {
    const DAY = 24 * 60 * 60_000;
    const ts = NOW - 8 * DAY;
    const out = formatCompletedAt(ts, NOW);
    expect(out).not.toMatch(/ago$/);
    expect(out).toBe(new Date(ts).toLocaleDateString());
  });

  it("clamps negative deltas (clock skew) to 'just now'", () => {
    expect(formatCompletedAt(NOW + 5_000, NOW)).toBe("just now");
  });
});
