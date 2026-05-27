/**
 * Tests for the additions to `paths.ts`:
 *   - `makeRunId` extension with optional `{ evalSet, arm }` for
 *     experiment-driven runs.
 *   - `RunPaths.manifestPath` and `RunPaths.tracesDir` for upload artifacts.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunPaths, makeRunId } from "./paths";

describe("makeRunId", () => {
  it("uses model-label + suite tail when evalSet/arm are absent (legacy shape)", () => {
    const id = makeRunId({ modelLabel: "claude-sonnet-4-5", suite: "webbench-mini" });

    // shape: <ts>-<modelLabel>-<suite>
    expect(id).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-claude-sonnet-4-5-webbench-mini$/,
    );
  });

  it("uses evalSet + arm tail when both are provided (experiment shape)", () => {
    const id = makeRunId({
      modelLabel: "claude-sonnet-4-5",
      evalSet: "example-experiment",
      arm: "arm-a",
    });

    // shape: <ts>-<evalSet>-<arm>
    expect(id).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-example-experiment-arm-a$/,
    );
  });

  it("sanitizes unsafe segments in evalSet and arm", () => {
    const id = makeRunId({
      modelLabel: "x",
      evalSet: "foo/bar:baz",
      arm: "arm one!",
    });

    // shape: <ts>-<sanitized-evalSet>-<sanitized-arm>
    expect(id).toMatch(/-foo_bar_baz-arm_one_$/);
  });

  it("falls back to legacy shape when only evalSet is provided (without arm)", () => {
    const id = makeRunId({ modelLabel: "claude", evalSet: "example-experiment" });

    expect(id).toMatch(/-claude-task$/); // unchanged legacy fallback
  });
});

describe("createRunPaths", () => {
  it("returns manifestPath and tracesDir alongside the existing fields", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bench-paths-"));
    const runDir = join(tmp, "run-1");

    const paths = createRunPaths(runDir);

    expect(paths.runDir).toBe(runDir);
    expect(paths.summaryPath).toBe(join(runDir, "summary.json"));
    expect(paths.trialsDir).toBe(join(runDir, "trials"));
    expect(paths.videosDir).toBe(join(runDir, "videos"));
    expect(paths.tracesDir).toBe(join(runDir, "traces"));
    expect(paths.manifestPath).toBe(join(runDir, "manifest.json"));
  });
});
