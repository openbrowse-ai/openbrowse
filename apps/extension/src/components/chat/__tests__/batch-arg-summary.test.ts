import { describe, expect, it } from "vitest";
import { summarizeArgs } from "../tool-results/batch";

describe("summarizeArgs", () => {
  it("keeps the argument that identifies the call", () => {
    // The old version showed the first three fields in insertion order,
    // so `numResults: 8` ate the half of the row that should have been
    // showing the query.
    expect(
      summarizeArgs({ query: "GRPO multi-turn agents", numResults: 8 }),
    ).toBe("query: GRPO multi-turn agents");
  });

  it("shows at most two arguments", () => {
    expect(summarizeArgs({ tab: "t1", mode: "viewport", selector: "main" })).toBe(
      "tab: t1 · mode: viewport",
    );
  });

  it("falls back to non-string arguments when there are no strings", () => {
    expect(summarizeArgs({ limit: 20, onlyErrors: true })).toBe(
      "limit: 20 · onlyErrors: true",
    );
  });

  it("elides a long summary to a single line", () => {
    const summary = summarizeArgs({
      query:
        "reinforcement learning for browser use agents 2025 training LLM web agents",
    });
    expect(summary.length).toBeLessThanOrEqual(52);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.startsWith("query: reinforcement learning")).toBe(true);
  });

  it("skips empty and absent values", () => {
    expect(summarizeArgs({ tab: "", selector: null, pattern: "TODO" })).toBe(
      "pattern: TODO",
    );
  });

  it("summarizes structured values by shape", () => {
    expect(summarizeArgs({ schema: { type: "object" } })).toBe("schema: {…}");
    expect(summarizeArgs({ handles: ["t1", "t2"] })).toBe("handles: [2]");
  });

  it("returns an empty string for no arguments", () => {
    expect(summarizeArgs({})).toBe("");
  });
});
