import { describe, expect, it } from "vitest";
import { resolveToolLabels } from "../ToolCallBlock";

/**
 * `resolveToolLabels` is the seam that lets a batched invocation reuse the
 * label its tool would show on its own row. Before it existed, batch child
 * rows fell back to a generic `key: value` argument dump, so a batched
 * `webSearch` read `webSearch  query: bio AI startups` while the same call
 * on its own read `Searched “bio AI startups” — 8 results`.
 */
describe("resolveToolLabels", () => {
  it("gives a batched webSearch the same label as a direct call", () => {
    const labels = resolveToolLabels(
      "webSearch",
      { query: "bio AI startups" },
      { results: [{}, {}, {}] },
    );

    expect(labels?.done).toBe("Searched “bio AI startups” — 3 results");
    expect(labels?.pending).toBe("Searching “bio AI startups”...");
  });

  it("surfaces a failed search rather than reporting it as done", () => {
    const labels = resolveToolLabels(
      "webSearch",
      { query: "bio AI startups" },
      { results: [], error: "upstream refused" },
    );

    expect(labels?.done).toBe("Search failed: “bio AI startups”");
  });

  it("reports the result count in the singular", () => {
    const labels = resolveToolLabels("webSearch", { query: "q" }, { results: [{}] });
    expect(labels?.done).toBe("Searched “q” — 1 result");
  });

  it("falls back to the static entry for a tool with no dynamic label", () => {
    // A batched Grep should read "Searched", not the bare tool name.
    expect(resolveToolLabels("Grep", { pattern: "x" }, undefined)).toEqual({
      pending: "Searching...",
      done: "Searched",
    });
  });

  it("splices the host into a webFetch label", () => {
    const labels = resolveToolLabels(
      "webFetch",
      { url: "https://openbrowse.ai/docs/tools" },
      undefined,
    );

    expect(labels?.done).toContain("openbrowse.ai");
  });

  it("reads read_artifact_diagnostics from the result, not the arguments", () => {
    const clean = resolveToolLabels(
      "read_artifact_diagnostics",
      {},
      { rendered: true, errors: [] },
    );
    expect(clean?.done).toBeTruthy();
    expect(clean?.done).not.toBe("read_artifact_diagnostics");
  });

  it("returns undefined for a tool with nothing specific to say", () => {
    // The signal a batch row uses to keep its argument summary instead of
    // degrading to the bare tool name.
    expect(resolveToolLabels("someUnknownTool", { a: 1 }, undefined)).toBeUndefined();
  });

  it("still resolves the batch tool itself, for a nested render", () => {
    const labels = resolveToolLabels(
      "batch",
      { description: "Comparing pricing pages", invocations: [{}, {}] },
      undefined,
    );

    expect(labels?.done).toBe("Comparing pricing pages");
  });

  it("does not throw on malformed arguments", () => {
    // Rows must render even when an invocation failed to parse its input.
    expect(() => resolveToolLabels("webSearch", {}, undefined)).not.toThrow();
    expect(() => resolveToolLabels("closeTabs", {}, undefined)).not.toThrow();
    expect(() => resolveToolLabels("computer", {}, undefined)).not.toThrow();
  });
});
