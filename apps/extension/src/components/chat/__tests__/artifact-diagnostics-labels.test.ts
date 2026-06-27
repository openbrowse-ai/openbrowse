import { describe, expect, it } from "vitest";
import { artifactDiagnosticsLabels } from "../ToolCallBlock";

const fallback = {
  pending: "Verifying artifact...",
  done: "Verified artifact",
};

describe("artifactDiagnosticsLabels", () => {
  it("reports a clean render", () => {
    expect(
      artifactDiagnosticsLabels(
        { rendered: { childCount: 3, bodyTextSample: "x" }, errors: [] },
        fallback,
      ),
    ).toEqual({ pending: "Verifying artifact...", done: "Rendered cleanly" });
  });

  it("reports a single error", () => {
    expect(
      artifactDiagnosticsLabels(
        { rendered: null, errors: [{ message: "boom", ts: 1 }] },
        fallback,
      ),
    ).toEqual({ pending: "Verifying artifact...", done: "Found 1 error" });
  });

  it("pluralizes multiple errors", () => {
    expect(
      artifactDiagnosticsLabels(
        {
          rendered: { childCount: 1, bodyTextSample: "" },
          errors: [
            { message: "a", ts: 1 },
            { message: "b", ts: 2 },
          ],
        },
        fallback,
      ).done,
    ).toBe("Found 2 errors");
  });

  it("errors take precedence over a render", () => {
    // Even if it rendered, surfacing the error is what matters.
    expect(
      artifactDiagnosticsLabels(
        {
          rendered: { childCount: 2, bodyTextSample: "" },
          errors: [{ message: "late throw", ts: 1 }],
        },
        fallback,
      ).done,
    ).toBe("Found 1 error");
  });

  it("reports no render when neither rendered nor errored", () => {
    expect(
      artifactDiagnosticsLabels({ rendered: null, errors: [] }, fallback).done,
    ).toBe("No render reported");
  });

  it("falls back for non-object results", () => {
    expect(artifactDiagnosticsLabels(undefined, fallback)).toBe(fallback);
    expect(artifactDiagnosticsLabels("nope", fallback)).toBe(fallback);
  });
});
