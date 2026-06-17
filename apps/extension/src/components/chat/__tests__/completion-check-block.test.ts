import { describe, expect, it } from "vitest";
import {
  selectHeading,
  selectVariant,
} from "../CompletionCheckBlock";
import type { CompletionCheckRejectionData } from "@/lib/types";

/**
 * Pure-function tests for the rejection-block render decisions. The
 * JSX rendering itself is verified manually; the variant + heading
 * helpers are extracted so the branching logic is exercised in unit
 * tests without React Testing Library setup.
 */

function makeData(
  overrides: Partial<CompletionCheckRejectionData>,
): CompletionCheckRejectionData {
  return {
    rejectionRound: 1,
    reasoning: "x",
    concerns: [],
    forceEmittedNext: false,
    ...overrides,
  };
}

describe("selectVariant", () => {
  it("evaluator-error reason short-circuits regardless of forceEmittedNext", () => {
    expect(
      selectVariant(
        makeData({ reason: "evaluator-error", forceEmittedNext: true }),
      ),
    ).toBe("evaluator-error");
    expect(
      selectVariant(
        makeData({ reason: "evaluator-error", forceEmittedNext: false }),
      ),
    ).toBe("evaluator-error");
  });

  it("forceEmittedNext === true → 'force-emit' (when not evaluator-error)", () => {
    expect(selectVariant(makeData({ forceEmittedNext: true }))).toBe(
      "force-emit",
    );
  });

  it("default → 'refining'", () => {
    expect(selectVariant(makeData({ forceEmittedNext: false }))).toBe(
      "refining",
    );
  });
});

describe("selectHeading", () => {
  it("evaluator-error renders the fixed plain-language string", () => {
    expect(selectHeading("evaluator-error", 0)).toBe(
      "Quality check skipped — evaluator could not complete.",
    );
    // Concern count is irrelevant for evaluator-error.
    expect(selectHeading("evaluator-error", 5)).toBe(
      "Quality check skipped — evaluator could not complete.",
    );
  });

  it("force-emit uses 'flagged' and the response-may-have-issues phrasing", () => {
    expect(selectHeading("force-emit", 1)).toBe(
      "This response may have issues (1 flagged)",
    );
    expect(selectHeading("force-emit", 3)).toBe(
      "This response may have issues (3 flagged)",
    );
  });

  it("refining pluralizes 'issue' for count 1, 'issues' otherwise", () => {
    expect(selectHeading("refining", 1)).toBe("Refining answer (1 issue)");
    expect(selectHeading("refining", 2)).toBe("Refining answer (2 issues)");
    // Edge: 0 concerns shouldn't normally happen for a rejection
    // block, but the helper is total — make sure it still pluralizes.
    expect(selectHeading("refining", 0)).toBe("Refining answer (0 issues)");
  });

  it("never includes the round number (UX preference: hide internal state)", () => {
    expect(selectHeading("refining", 1)).not.toMatch(/round/i);
    expect(selectHeading("force-emit", 1)).not.toMatch(/round/i);
  });

  it("never includes evaluator-internal jargon (dimension names)", () => {
    const tokens = ["completeness", "planClosure", "noPrematureHandoff"];
    for (const t of tokens) {
      expect(selectHeading("refining", 1)).not.toContain(t);
      expect(selectHeading("force-emit", 1)).not.toContain(t);
      expect(selectHeading("evaluator-error", 0)).not.toContain(t);
    }
  });
});
