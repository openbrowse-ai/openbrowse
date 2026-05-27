/**
 * Tests for `runs.ts` — pure split/merge of a `TrialResult` into a
 * lightweight (uploadable + locally-kept) shell + a full trace blob.
 */

import { describe, expect, it } from "vitest";
import { mergeTrial, splitTrial, type FullTrace } from "./runs";
import type { TrialResult } from "./runner";

function makeTrial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    taskId: "webbench-1001",
    modelLabel: "claude-sonnet-4-5",
    agentModelId: "claude-sonnet-4-5-20250929",
    systemPromptId: "default",
    toolSetId: "set:click+navigate",
    passed: true,
    agentAnswer: "42",
    finalUrl: "https://example.com",
    durationMs: 12345,
    steps: 4,
    tokens: { in: 1000, out: 200, total: 1200 },
    judge: { passed: true, reasoning: "matches" },
    trace: [
      { name: "navigate", input: { url: "https://example.com" }, output: { ok: true } },
      { name: "click", input: { selector: "h1" }, output: { ok: true } },
    ],
    parts: [{ type: "text", text: "thinking…" }, { type: "dynamic-tool", toolName: "click" }],
    videoPath: "/tmp/.bench/runs/r1/videos/webbench-1001.mp4",
    ...overrides,
  };
}

describe("splitTrial", () => {
  it("clears trace and parts on the lightweight half", () => {
    const trial = makeTrial();

    const { lightweight } = splitTrial(trial);

    expect(lightweight.trace).toEqual([]);
    expect(lightweight.parts).toBeUndefined();
  });

  it("preserves every other field on the lightweight half byte-for-byte", () => {
    const trial = makeTrial();

    const { lightweight } = splitTrial(trial);

    // Compare with trace+parts stripped from the original.
    const { trace: _t, parts: _p, ...rest } = trial;
    expect(lightweight).toMatchObject(rest);
  });

  it("captures the full heavy fields in the trace half", () => {
    const trial = makeTrial();

    const { fullTrace } = splitTrial(trial);

    expect(fullTrace.taskId).toBe(trial.taskId);
    expect(fullTrace.trace).toEqual(trial.trace);
    expect(fullTrace.parts).toEqual(trial.parts);
  });

  it("does not mutate the input trial", () => {
    const trial = makeTrial();
    const traceBefore = JSON.stringify(trial.trace);
    const partsBefore = JSON.stringify(trial.parts);

    splitTrial(trial);

    expect(JSON.stringify(trial.trace)).toBe(traceBefore);
    expect(JSON.stringify(trial.parts)).toBe(partsBefore);
  });

  it("handles a trial with no parts field (timeout-error path)", () => {
    const trial = makeTrial({ parts: undefined });

    const { lightweight, fullTrace } = splitTrial(trial);

    expect(lightweight.parts).toBeUndefined();
    expect(fullTrace.parts).toEqual([]);
  });

  it("handles a trial with empty trace (timeout-error path)", () => {
    const trial = makeTrial({ trace: [] });

    const { lightweight, fullTrace } = splitTrial(trial);

    expect(lightweight.trace).toEqual([]);
    expect(fullTrace.trace).toEqual([]);
  });
});

describe("mergeTrial", () => {
  it("round-trips: split + merge reconstructs the original trial", () => {
    const trial = makeTrial();

    const { lightweight, fullTrace } = splitTrial(trial);
    const reconstructed = mergeTrial(lightweight, fullTrace);

    expect(reconstructed).toEqual(trial);
  });

  it("rejects merging when taskIds disagree", () => {
    const trial = makeTrial();
    const { lightweight, fullTrace } = splitTrial(trial);
    const wrongTrace: FullTrace = { ...fullTrace, taskId: "webbench-9999" };

    expect(() => mergeTrial(lightweight, wrongTrace)).toThrow(/taskId/i);
  });
});
