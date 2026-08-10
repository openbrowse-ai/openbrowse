import { describe, expect, it } from "vitest";
import { buildSegments, findNarrationIndices } from "../AssistantMessage";

type Parts = Parameters<typeof buildSegments>[0];
type Part = Parts[number];

let seq = 0;

const text = (t: string): Part => ({ type: "text", text: t }) as unknown as Part;
const longText = (n: number): Part => text("x".repeat(n));
const tool = (name = "snapshot"): Part =>
  ({
    type: `tool-${name}`,
    toolCallId: `call-${++seq}`,
    state: "output-available",
    input: {},
    output: { ok: true },
  }) as unknown as Part;
const reasoning = (t = "hmm"): Part =>
  ({ type: "reasoning", text: t }) as unknown as Part;
const stepStart = (): Part => ({ type: "step-start" }) as unknown as Part;

const indices = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("findNarrationIndices", () => {
  it("treats between-call commentary as narration and the trailing text as the answer", () => {
    const parts = [text("Let me look."), tool(), tool(), text("Answer.")];
    expect(indices(findNarrationIndices(parts))).toEqual([0]);
  });

  it("never folds substantial prose, even when tool calls follow it", () => {
    // The answer-then-cleanup shape: long answer, then `closeTabs`.
    const parts = [longText(500), tool("closeTabs")];
    expect(indices(findNarrationIndices(parts))).toEqual([]);
  });

  it("protects a terse final answer followed by tab cleanup", () => {
    const parts = [
      text("Let me look."),
      tool(),
      text("Done — updated 3 rows."),
      tool("closeTabs"),
    ];
    expect(indices(findNarrationIndices(parts))).toEqual([0]);
  });

  it("treats trailing text as narration while streaming, as the answer once done", () => {
    const parts = [text("Checking the pricing page."), tool(), tool()];
    expect(indices(findNarrationIndices(parts, { isStreaming: true }))).toEqual([0]);
    expect(indices(findNarrationIndices(parts))).toEqual([]);
  });

  it("ignores text with no tool call after it", () => {
    const parts = [tool(), text("All done.")];
    expect(indices(findNarrationIndices(parts, { isStreaming: true }))).toEqual([]);
  });

  it("ignores whitespace-only text parts", () => {
    const parts = [text("   \n  "), tool(), tool()];
    expect(indices(findNarrationIndices(parts, { isStreaming: true }))).toEqual([]);
  });

  it("classifies every intermediate note in a long run", () => {
    const parts = [
      text("Opening the dashboard."),
      tool(),
      text("Filtering to last week."),
      tool(),
      text("Reading the totals."),
      tool(),
      text("Revenue was $12,400 last week, up 8%."),
    ];
    expect(indices(findNarrationIndices(parts))).toEqual([0, 2, 4]);
  });
});

describe("buildSegments", () => {
  const parts = [
    text("Let me look."),
    tool(),
    tool(),
    text("Now the settings page."),
    tool(),
    tool(),
    text("Here's the answer."),
  ];

  it("merges narration-separated tool runs into a single group", () => {
    const segments = buildSegments(parts, findNarrationIndices(parts));
    expect(segments.map((s) => s.kind)).toEqual(["group", "break"]);

    const group = segments[0];
    if (group.kind !== "group") throw new Error("expected a group segment");
    expect(group.parts.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("without narration classification, every text part is a hard break", () => {
    // Regression guard: this is the shape that produced the alternating
    // prose / "Completed N steps" transcript, and it also starves each group
    // of the tool calls it needs to be worth folding.
    expect(buildSegments(parts).map((s) => s.kind)).toEqual([
      "break",
      "group",
      "break",
      "group",
      "break",
    ]);
  });

  it("keeps reasoning and step-start inside the work group", () => {
    const p = [stepStart(), reasoning(), tool(), tool()];
    expect(buildSegments(p).map((s) => s.kind)).toEqual(["group"]);
  });

  it("leaves a message with no tool calls as a single break", () => {
    const p = [text("Just answering directly.")];
    const segments = buildSegments(p, findNarrationIndices(p));
    expect(segments.map((s) => s.kind)).toEqual(["break"]);
  });
});
