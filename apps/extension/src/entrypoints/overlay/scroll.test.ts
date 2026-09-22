import { describe, expect, it } from "vitest";
import { nextScrollTop, type ScrollMetrics } from "./scroll";

/**
 * Regression coverage for the palette's "search input scrolled off the top"
 * bug. Focus movement used `Element.scrollIntoView`, which scrolls *every*
 * scrollable ancestor — including the palette's own document when it was
 * taller than the frame the host gave it. Hovering a command row was enough to
 * drag the header out of view.
 *
 * `nextScrollTop` is the replacement's math: it only ever produces a
 * `scrollTop` for the row's own list.
 */
const metrics = (over: Partial<ScrollMetrics> = {}): ScrollMetrics => ({
  scrollTop: 0,
  clientHeight: 240,
  rowTop: 0,
  rowHeight: 30,
  scrollHeight: 900,
  ...over,
});

describe("nextScrollTop (nearest)", () => {
  it("does not move when the row is already fully visible", () => {
    // The pointer-driven case: hovering a visible row sets focusIndex, and
    // that must not scroll anything.
    const m = metrics({ scrollTop: 120, rowTop: 150 });
    expect(nextScrollTop(m)).toBe(120);
  });

  it("scrolls up by the minimum amount for a row above the viewport", () => {
    expect(nextScrollTop(metrics({ scrollTop: 300, rowTop: 210 }))).toBe(210);
  });

  it("scrolls down by the minimum amount for a row below the viewport", () => {
    // Row spans 400–430 with a 240px viewport at 100 → bottom-aligns at 190.
    expect(nextScrollTop(metrics({ scrollTop: 100, rowTop: 400 }))).toBe(190);
  });

  it("treats a row flush with the bottom edge as visible", () => {
    expect(nextScrollTop(metrics({ scrollTop: 100, rowTop: 310 }))).toBe(100);
  });

  it("never scrolls past the end of the content", () => {
    const m = metrics({ scrollTop: 0, rowTop: 880, scrollHeight: 900 });
    expect(nextScrollTop(m)).toBe(900 - 240);
  });

  it("never returns a negative offset", () => {
    const m = metrics({ scrollTop: 10, rowTop: 0, clientHeight: 240 });
    expect(nextScrollTop(m)).toBe(0);
  });

  it("stays put when the list does not scroll at all", () => {
    const m = metrics({
      scrollTop: 0,
      clientHeight: 300,
      scrollHeight: 300,
      rowTop: 280,
    });
    expect(nextScrollTop(m)).toBe(0);
  });
});

describe("nextScrollTop (center)", () => {
  it("centers the row in the viewport", () => {
    // 400 - (240 - 30) / 2 = 295
    expect(nextScrollTop(metrics({ rowTop: 400 }), "center")).toBe(295);
  });

  it("clamps centering at both ends of the content", () => {
    expect(nextScrollTop(metrics({ rowTop: 10 }), "center")).toBe(0);
    expect(nextScrollTop(metrics({ rowTop: 890 }), "center")).toBe(660);
  });
});
