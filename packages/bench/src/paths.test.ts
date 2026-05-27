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

    // shape: <ts>-<rand>-<modelLabel>-<suite>
    expect(id).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{4}-claude-sonnet-4-5-webbench-mini$/,
    );
  });

  it("uses evalSet + arm tail when both are provided (experiment shape)", () => {
    const id = makeRunId({
      modelLabel: "claude-sonnet-4-5",
      evalSet: "example-experiment",
      arm: "arm-a",
    });

    // shape: <ts>-<rand>-<evalSet>-<arm>
    expect(id).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{4}-example-experiment-arm-a$/,
    );
  });

  it("sanitizes unsafe segments in evalSet and arm", () => {
    const id = makeRunId({
      modelLabel: "x",
      evalSet: "foo/bar:baz",
      arm: "arm one!",
    });

    // shape: <ts>-<rand>-<sanitized-evalSet>-<sanitized-arm>
    expect(id).toMatch(/-[0-9a-f]{4}-foo_bar_baz-arm_one_$/);
  });

  it("falls back to legacy shape when only evalSet is provided (without arm)", () => {
    const id = makeRunId({ modelLabel: "claude", evalSet: "example-experiment" });

    expect(id).toMatch(/-[0-9a-f]{4}-claude-task$/); // unchanged legacy fallback
  });

  it("produces unique ids for rapid back-to-back invocations within the same second", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(makeRunId({ modelLabel: "m", evalSet: "e", arm: "a" }));
    }
    // Without the entropy suffix, all 100 ids would collapse into 1-2 unique
    // values (depending on whether the loop crosses a second boundary). With
    // 4 hex chars of entropy, collisions are vanishingly rare.
    expect(ids.size).toBeGreaterThanOrEqual(99);
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
