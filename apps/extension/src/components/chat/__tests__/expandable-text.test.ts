import { describe, expect, it } from "vitest";
import { estimateVisualLines } from "../tool-results/expandable-text";

/**
 * Pure-function tests for the visual-line estimator. The component's
 * collapse decision keys off this estimate, so the branches we care
 * about — short newline-rich strings, long single-line strings, mixed
 * — are exercised here without React Testing Library setup.
 *
 * Background: before this change, `ExpandableText` only collapsed when
 * `text.split("\n").length > maxLines`, so a 1-line, 600-char tool
 * error wrapped to 7-8 visual lines but the clamp never fired. The
 * estimator counts both `\n`-delimited lines and visually-wrapped long
 * lines so the new gate `estimateVisualLines(text) > maxLines` catches
 * both shapes.
 */

const COL_WIDTH = 80; // matches the component's default

describe("estimateVisualLines", () => {
  it("returns 0 for empty input", () => {
    expect(estimateVisualLines("")).toBe(0);
  });

  it("counts each \\n-delimited line as at least one visual line", () => {
    expect(estimateVisualLines("a\nb\nc")).toBe(3);
  });

  it("treats a blank line as one visual line (preserves spacing)", () => {
    expect(estimateVisualLines("a\n\nb")).toBe(3);
  });

  it("estimates a single long line by character-width wrapping", () => {
    // 600 chars / 80 per line = 8 visual lines.
    const text = "x".repeat(600);
    expect(estimateVisualLines(text, COL_WIDTH)).toBe(Math.ceil(600 / 80));
  });

  it("rounds up partial lines (a 100-char line is 2 visual lines)", () => {
    expect(estimateVisualLines("y".repeat(100), COL_WIDTH)).toBe(2);
  });

  it("sums newline-delimited segments individually rather than wrapping the whole string", () => {
    // Two short lines separated by \n should be 2 visual lines, NOT
    // ceil(total/80) — preserves the user's authored line breaks.
    const text = `${"a".repeat(50)}\n${"b".repeat(50)}`;
    expect(estimateVisualLines(text, COL_WIDTH)).toBe(2);
  });

  it("handles a long line followed by short lines", () => {
    const text = `${"a".repeat(200)}\nb\nc`;
    // 200/80 = 3 lines for the first segment, +1 +1 for the rest.
    expect(estimateVisualLines(text, COL_WIDTH)).toBe(5);
  });

  // Regression: the original component bug. A 1-line, 600-char error
  // had visualLines=8 but lines.length=1, so the old gate
  // (`lines.length > maxLines`) returned false. The new estimator
  // returns 8, so a `> 10` cap still doesn't fire here — which is
  // correct, the new behavior should match the old `lines.length`
  // count when content is short — but the clamp with `maxLines: 7`
  // demonstrates the case the old code missed.
  it("would clamp a single 600-char line at maxLines=7 (old behavior would not)", () => {
    const text = "x".repeat(600);
    const visualLines = estimateVisualLines(text, COL_WIDTH);
    expect(visualLines).toBeGreaterThan(7);
    // Old behavior: text.split("\n").length === 1 → never clamps.
    expect(text.split("\n").length).toBe(1);
  });

  it("uses a configurable charsPerLine when callers want a tighter clamp", () => {
    expect(estimateVisualLines("a".repeat(40), 40)).toBe(1);
    expect(estimateVisualLines("a".repeat(41), 40)).toBe(2);
  });
});
