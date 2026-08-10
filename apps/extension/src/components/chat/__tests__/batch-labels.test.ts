import { describe, expect, it } from "vitest";
import { batchLabels } from "../ToolCallBlock";

const fallback = { pending: "Running batch...", done: "Ran batch" };

const args = (description: unknown, count: number) => ({
  ...(description === undefined ? {} : { description }),
  invocations: Array.from({ length: count }, () => ({ name: "readPage" })),
});

const results = (...oks: boolean[]) => ({
  results: oks.map((ok, i) => ({ name: `tool${i}`, ok })),
});

describe("batchLabels", () => {
  it("uses the model's description while running, sized not paced", () => {
    // `batch` returns one aggregate output, so there is no honest
    // mid-flight progress to show — state the size of the job instead.
    const labels = batchLabels(args("Comparing pricing pages", 4), undefined, fallback);
    expect(labels.pending).toBe("Comparing pricing pages...");
    expect(labels.meta).toBe("4 reads");
    expect(labels.metaTone).toBe("muted");
  });

  it("keeps the description verbatim after completion", () => {
    // Deliberately NOT re-tensed to "Compared…": conjugating arbitrary
    // model text is brittle in English and wrong in other languages.
    const labels = batchLabels(
      args("Comparing pricing pages", 4),
      results(true, true, true, true),
      fallback,
    );
    expect(labels.done).toBe("Comparing pricing pages");
    expect(labels.meta).toBe("4 of 4");
    expect(labels.metaTone).toBe("muted");
  });

  it("reports partial success as a warning, not a failure", () => {
    const labels = batchLabels(
      args("Comparing pricing pages", 4),
      results(true, true, true, false),
      fallback,
    );
    expect(labels.done).toBe("Comparing pricing pages");
    expect(labels.meta).toBe("3 of 4");
    expect(labels.metaTone).toBe("warning");
  });

  it("counts against results actually returned, not invocations requested", () => {
    // A cancelled run reports every queued invocation, so the two agree;
    // this guards the label against ever reading "5 of 4".
    const labels = batchLabels(
      args("Reading sources", 2),
      results(true, false, false),
      fallback,
    );
    expect(labels.meta).toBe("1 of 3");
  });

  it("surfaces a whole-tool failure without implying clean reads", () => {
    const labels = batchLabels(
      args("Comparing pricing pages", 4),
      { error: "workspace unavailable" },
      fallback,
    );
    expect(labels.done).toBe("Comparing pricing pages");
    expect(labels.meta).toBe("Failed");
    expect(labels.metaTone).toBe("warning");
  });

  it("singularizes a one-read job", () => {
    expect(batchLabels(args("Checking the changelog", 1), undefined, fallback).meta)
      .toBe("1 read");
  });

  it("describes the shape of the work when no description was sent", () => {
    // Legacy persisted rows and mid-stream inputs land here. Never show
    // the raw tool name to the user.
    const labels = batchLabels(args(undefined, 3), undefined, fallback);
    expect(labels.pending).toBe("Running 3 reads...");
    expect(labels.done).toBe("Ran 3 reads");
  });

  it("does not state the count twice when the label already carries it", () => {
    // Fallback label is "Ran 4 reads", so a trailing "4 of 4" is noise.
    const labels = batchLabels(
      args(undefined, 4),
      results(true, true, true, true),
      fallback,
    );
    expect(labels.done).toBe("Ran 4 reads");
    expect(labels.meta).toBeUndefined();
  });

  it("still shows the tally on a partial run without a description", () => {
    // "Ran 4 reads" alone would hide that one of them did not land.
    const labels = batchLabels(
      args(undefined, 4),
      results(true, true, true, false),
      fallback,
    );
    expect(labels.done).toBe("Ran 4 reads");
    expect(labels.meta).toBe("3 of 4");
    expect(labels.metaTone).toBe("warning");
  });

  it("omits the running size hint when the label already counts the reads", () => {
    const labels = batchLabels(args(undefined, 4), undefined, fallback);
    expect(labels.pending).toBe("Running 4 reads...");
    expect(labels.meta).toBeUndefined();
  });

  it("falls back to the static labels with neither description nor invocations", () => {
    const labels = batchLabels({}, undefined, fallback);
    expect(labels.pending).toBe(fallback.pending);
    expect(labels.done).toBe(fallback.done);
    expect(labels.meta).toBeUndefined();
  });

  it("still labels a completed run whose description never arrived", () => {
    const labels = batchLabels(args(undefined, 2), results(true, false), fallback);
    expect(labels.done).toBe("Ran 2 reads");
    expect(labels.meta).toBe("1 of 2");
    expect(labels.metaTone).toBe("warning");
  });
});
