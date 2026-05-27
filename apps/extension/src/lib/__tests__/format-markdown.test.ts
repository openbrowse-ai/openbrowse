import { describe, expect, it } from "vitest";
import {
  formatMessageAsMarkdown,
  formatPartAsMarkdown,
} from "../format-markdown";
import { COMPLETION_CHECK_PREFIX } from "../agent/compacting-transport";
import type {
  CompletionCheckRejectionData,
  CompletionCheckRunningData,
} from "../types";

/**
 * Markdown rendering for chat exports + per-message Copy.
 *
 * The export pipeline (`handleExportChat` in sidepanel/home App.tsx)
 * routes every part through `formatPartAsMarkdown`. Anything that
 * returns null is silently dropped from the export. The completion-
 * check parts (`data-completion-check-rejection`,
 * `data-completion-check-running`) used to fall through to null,
 * meaning exports were missing audit-trail info the user saw on
 * screen. These tests pin the rendering contract so future part
 * types don't get accidentally dropped.
 */

describe("formatPartAsMarkdown — completion-check parts", () => {
  it("renders a mid-loop rejection block as a blockquote with reasoning + concerns", () => {
    const data: CompletionCheckRejectionData = {
      rejectionRound: 1,
      reasoning: "Two specific gaps.",
      concerns: [
        {
          dimension: "completeness",
          detail: "Asked for top 3 but listed 2.",
          userSummary: "Only 2 items listed but 3 were requested.",
          evidence: "draft mentions only 2 items",
        },
        {
          dimension: "evidenceGrounding",
          detail: "Price $149 not present in any tool call this turn.",
          userSummary: "The price ($149) wasn't verified on any page.",
        },
      ],
      forceEmittedNext: false,
    };
    const out = formatPartAsMarkdown({
      type: "data-completion-check-rejection",
      data,
    });
    // Heading uses the in-loop label, not the failed label.
    expect(out).toContain("> **Completion check**");
    expect(out).not.toContain("Completion check failed");
    // Reasoning + concerns rendered as blockquote.
    expect(out).toContain("> Two specific gaps.");
    expect(out).toContain("> - **completeness**: Asked for top 3 but listed 2.");
    expect(out).toContain(">   _Evidence:_ draft mentions only 2 items");
    expect(out).toContain(
      "> - **evidenceGrounding**: Price $149 not present in any tool call this turn.",
    );
  });

  it("does NOT include the redundant 'follow-up sent to agent' code block", () => {
    // Anti-regression: the follow-up payload duplicates the reasoning
    // and concerns already rendered in the blockquote above. Earlier
    // versions of this function appended a fenced code block with the
    // synthetic message that was sent to the agent. Removed because
    // the only unique content (round number + boilerplate directive)
    // doesn't earn its keep.
    const data: CompletionCheckRejectionData = {
      rejectionRound: 1,
      reasoning: "Issue.",
      concerns: [
        {
          dimension: "completeness",
          detail: "Asked for top 3 but listed 2.",
          userSummary: "Only 2 items listed but 3 were requested.",
        },
      ],
      forceEmittedNext: false,
    };
    const out = formatPartAsMarkdown({
      type: "data-completion-check-rejection",
      data,
    });
    expect(out).not.toContain("_Follow-up sent to agent:_");
    expect(out).not.toContain(COMPLETION_CHECK_PREFIX);
    expect(out).not.toContain("Continue working until each concern is resolved");
    // No round number leak either.
    expect(out).not.toContain("(round 1)");
    // The reasoning and concern themselves should appear EXACTLY ONCE
    // in the output (not duplicated by the removed follow-up section).
    expect(out?.split("Asked for top 3 but listed 2.").length).toBe(2);
    expect(out?.split("Issue.").length).toBe(2);
  });

  it("renders a force-emit rejection block with 'failed' heading", () => {
    const data: CompletionCheckRejectionData = {
      rejectionRound: 3,
      reasoning: "Still not addressed.",
      concerns: [
        {
          dimension: "completeness",
          detail: "still incomplete",
          userSummary: "The response is still incomplete.",
        },
      ],
      forceEmittedNext: true,
    };
    const out = formatPartAsMarkdown({
      type: "data-completion-check-rejection",
      data,
    });
    expect(out).toContain("> **Completion check failed**");
    expect(out).toContain("> - **completeness**: still incomplete");
    // Force-emit also doesn't include the (now-removed) follow-up
    // section. Anti-regression to keep parity with mid-loop rejections.
    expect(out).not.toContain("_Follow-up sent to agent:_");
    expect(out).not.toContain(COMPLETION_CHECK_PREFIX);
  });

  it("renders evaluator-error rejection as a single italic note, no concerns enumerated", () => {
    const data: CompletionCheckRejectionData = {
      rejectionRound: 1,
      reasoning: "Evaluator error: No output generated.",
      // The evaluator-error path may carry zero or many synthetic
      // concerns; either way, exports collapse to the single italic line.
      concerns: [
        {
          dimension: "completeness",
          detail: "synthetic concern",
          userSummary: "synthetic user summary",
        },
      ],
      forceEmittedNext: true,
      reason: "evaluator-error",
    };
    const out = formatPartAsMarkdown({
      type: "data-completion-check-rejection",
      data,
    });
    expect(out).toBe(
      "> _Quality check skipped — evaluator could not complete._",
    );
    // The synthetic concern is intentionally NOT rendered for
    // evaluator-error: the user shouldn't see fake concerns from a
    // failed verifier.
    expect(out).not.toContain("synthetic concern");
    expect(out).not.toContain("Completion check");
  });

  it("renders a rejection block with no evidence (no Evidence: line)", () => {
    const data: CompletionCheckRejectionData = {
      rejectionRound: 1,
      reasoning: "x",
      concerns: [
        {
          dimension: "completeness",
          detail: "missing item",
          userSummary: "Something's missing.",
        },
      ],
      forceEmittedNext: false,
    };
    const out = formatPartAsMarkdown({
      type: "data-completion-check-rejection",
      data,
    });
    expect(out).not.toContain("_Evidence:_");
  });

  it("running indicator (evaluating phase) is dropped from exports", () => {
    const data: CompletionCheckRunningData = {
      id: "run-1",
      phase: "evaluating",
    };
    const out = formatPartAsMarkdown({
      type: "data-completion-check-running",
      data,
    });
    expect(out).toBeNull();
  });

  it("running indicator (done + approved → would be Verified badge) is dropped from exports", () => {
    const data: CompletionCheckRunningData = {
      id: "run-1",
      phase: "done",
      outcome: "approved",
    };
    const out = formatPartAsMarkdown({
      type: "data-completion-check-running",
      data,
    });
    expect(out).toBeNull();
  });

  it("running indicator (done + rejected) is dropped from exports", () => {
    const data: CompletionCheckRunningData = {
      id: "run-1",
      phase: "done",
      outcome: "rejected",
    };
    const out = formatPartAsMarkdown({
      type: "data-completion-check-running",
      data,
    });
    expect(out).toBeNull();
  });
});

describe("formatMessageAsMarkdown — mixed parts integration", () => {
  it("preserves order: text → rejection block → text", () => {
    const data: CompletionCheckRejectionData = {
      rejectionRound: 1,
      reasoning: "Issue.",
      concerns: [
        {
          dimension: "completeness",
          detail: "missing 3rd",
          userSummary: "Third item is missing.",
        },
      ],
      forceEmittedNext: false,
    };
    const message = {
      parts: [
        { type: "text", text: "Here is what I found." },
        { type: "data-completion-check-rejection", data },
        { type: "text", text: "Final answer after fix." },
      ],
    };
    const out = formatMessageAsMarkdown(message);
    const firstTextIdx = out.indexOf("Here is what I found.");
    const blockIdx = out.indexOf("> **Completion check**");
    const secondTextIdx = out.indexOf("Final answer after fix.");
    expect(firstTextIdx).toBeGreaterThanOrEqual(0);
    expect(blockIdx).toBeGreaterThan(firstTextIdx);
    expect(secondTextIdx).toBeGreaterThan(blockIdx);
  });

  it("running indicators are completely absent from a mixed message export", () => {
    const runningData: CompletionCheckRunningData = {
      id: "run-1",
      phase: "done",
      outcome: "approved",
    };
    const message = {
      parts: [
        { type: "text", text: "An answer." },
        { type: "data-completion-check-running", data: runningData },
      ],
    };
    const out = formatMessageAsMarkdown(message);
    expect(out).toBe("An answer.");
    // Just to be explicit: no Verified marker leaked.
    expect(out).not.toMatch(/verified/i);
  });
});
