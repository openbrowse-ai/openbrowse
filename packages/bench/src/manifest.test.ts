/**
 * Tests for `manifest.ts` — pure manifest builder + R2-key derivation.
 */

import { describe, expect, it } from "vitest";
import {
  buildManifest,
  r2KeysFor,
  type ManifestTrialUpload,
} from "./manifest";

describe("r2KeysFor", () => {
  it("derives per-task keys keyed off runId + taskId", () => {
    const keys = r2KeysFor({
      runId: "2026-05-26T10-30-00-example-experiment-arm-a",
      taskId: "webbench-1001",
      compressionAlgo: "zstd",
      videoExt: "mp4",
    });

    expect(keys).toEqual({
      trial:
        "runs/2026-05-26T10-30-00-example-experiment-arm-a/trials/webbench-1001.json",
      trace:
        "traces/2026-05-26T10-30-00-example-experiment-arm-a/webbench-1001.json.zst",
      video:
        "videos/2026-05-26T10-30-00-example-experiment-arm-a/webbench-1001.mp4",
      summary:
        "runs/2026-05-26T10-30-00-example-experiment-arm-a/summary.json",
    });
  });

  it("uses .gz suffix when compression is gzip", () => {
    const keys = r2KeysFor({
      runId: "r1",
      taskId: "t1",
      compressionAlgo: "gzip",
      videoExt: "mp4",
    });

    expect(keys.trace).toBe("traces/r1/t1.json.gz");
  });

  it("respects a webm video extension when ffmpeg conversion didn't run", () => {
    const keys = r2KeysFor({
      runId: "r1",
      taskId: "t1",
      compressionAlgo: "zstd",
      videoExt: "webm",
    });

    expect(keys.video).toBe("videos/r1/t1.webm");
  });

  it("derives the run-level summary key", () => {
    const keys = r2KeysFor({
      runId: "r1",
      taskId: null,
      compressionAlgo: "zstd",
      videoExt: "mp4",
    });

    expect(keys.summary).toBe("runs/r1/summary.json");
  });
});

describe("buildManifest", () => {
  it("returns a manifest with all fields populated and a per-trial entry", () => {
    const uploads: ManifestTrialUpload[] = [
      {
        taskId: "webbench-1001",
        traceKey: "traces/run1/webbench-1001.json.zst",
        traceBytes: 142000,
        videoKey: "videos/run1/webbench-1001.mp4",
        videoBytes: 3940000,
      },
    ];

    const manifest = buildManifest({
      runId: "run1",
      evalSet: "example-experiment",
      arm: "arm-a",
      bucket: "test-bucket",
      compression: "zstd",
      uploadedAt: "2026-05-26T10:48:12.444Z",
      uploads,
    });

    expect(manifest).toEqual({
      runId: "run1",
      evalSet: "example-experiment",
      arm: "arm-a",
      uploadedAt: "2026-05-26T10:48:12.444Z",
      bucket: "test-bucket",
      compression: "zstd",
      trials: {
        "webbench-1001": {
          trace: "traces/run1/webbench-1001.json.zst",
          video: "videos/run1/webbench-1001.mp4",
          traceBytes: 142000,
          videoBytes: 3940000,
        },
      },
    });
  });

  it("omits per-trial video fields when no video was recorded", () => {
    const manifest = buildManifest({
      runId: "run1",
      evalSet: "example-experiment",
      arm: "arm-a",
      bucket: "test-bucket",
      compression: "zstd",
      uploadedAt: "2026-05-26T10:48:12.444Z",
      uploads: [
        {
          taskId: "t1",
          traceKey: "traces/run1/t1.json.zst",
          traceBytes: 1000,
          videoKey: null,
          videoBytes: null,
        },
      ],
    });

    expect(manifest.trials.t1).toEqual({
      trace: "traces/run1/t1.json.zst",
      traceBytes: 1000,
    });
  });

  it("supports an empty uploads array", () => {
    const manifest = buildManifest({
      runId: "run1",
      evalSet: "example-experiment",
      arm: "arm-a",
      bucket: "test-bucket",
      compression: "zstd",
      uploadedAt: "2026-05-26T10:48:12.444Z",
      uploads: [],
    });

    expect(manifest.trials).toEqual({});
  });

  it("rejects duplicate taskIds in uploads", () => {
    expect(() =>
      buildManifest({
        runId: "run1",
        evalSet: "x",
        arm: "y",
        bucket: "b",
        compression: "zstd",
        uploadedAt: "2026-05-26T10:48:12.444Z",
        uploads: [
          { taskId: "t1", traceKey: "k", traceBytes: 1, videoKey: null, videoBytes: null },
          { taskId: "t1", traceKey: "k2", traceBytes: 2, videoKey: null, videoBytes: null },
        ],
      }),
    ).toThrow(/duplicate taskId/i);
  });
});
