/**
 * Tests for `upload.ts` — uploadRun() with a mocked S3 client.
 *
 * The S3 client is injected via `deps.s3Client` so we can record every
 * `PutObjectCommand` and assert exact key/body payloads without hitting
 * the network. Real R2 calls are exercised manually (Phase 2.8 smoke).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { uploadRun, type UploadDeps } from "./upload";
import { decompress } from "./compress";
import type { TrialResult } from "./runner";

interface RecordedPut {
  key: string;
  body: Buffer;
  contentType?: string;
}

function makeMockS3(failOn?: (cmd: PutObjectCommand) => boolean): {
  client: S3Client;
  puts: RecordedPut[];
} {
  const puts: RecordedPut[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) {
      if (failOn && failOn(cmd)) {
        throw new Error("simulated S3 failure");
      }
      const input = cmd.input;
      const body = input.Body as Buffer | string;
      puts.push({
        key: input.Key!,
        body: Buffer.isBuffer(body) ? body : Buffer.from(body as string),
        contentType: input.ContentType,
      });
      return {};
    }
    throw new Error(`unexpected command ${(cmd as { constructor: { name: string } }).constructor.name}`);
  });
  // Cast through unknown; we only call .send().
  const client = { send } as unknown as S3Client;
  return { client, puts };
}

function makeTrial(taskId: string): TrialResult {
  return {
    taskId,
    modelLabel: "claude-sonnet-4-5",
    agentModelId: "claude-sonnet-4-5-20250929",
    systemPromptId: "default",
    toolSetId: "set:click",
    passed: true,
    agentAnswer: "ok",
    finalUrl: "https://example.com",
    durationMs: 1000,
    steps: 2,
    tokens: { in: 50, out: 10, total: 60 },
    judge: { passed: true, reasoning: "looks right" },
    trace: [
      { name: "navigate", input: { url: "https://example.com" }, output: { ok: true } },
    ],
    parts: [{ type: "text", text: "thinking…" }],
  };
}

function makeRunDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "bench-upload-"));
  const runDir = join(tmp, "run-1");
  mkdirSync(join(runDir, "trials"), { recursive: true });
  mkdirSync(join(runDir, "videos"), { recursive: true });
  return runDir;
}

let dirsToCleanup: string[] = [];
beforeEach(() => {
  dirsToCleanup = [];
});
afterEach(() => {
  for (const d of dirsToCleanup) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function trackForCleanup(runDir: string): void {
  dirsToCleanup.push(runDir);
}

function paths(runDir: string) {
  return {
    runDir,
    trialsDir: join(runDir, "trials"),
    videosDir: join(runDir, "videos"),
    tracesDir: join(runDir, "traces"),
    summaryPath: join(runDir, "summary.json"),
    manifestPath: join(runDir, "manifest.json"),
  };
}

const FIXED_NOW = new Date("2026-05-26T10:48:12.444Z");
const fixedDeps = (mock: ReturnType<typeof makeMockS3>): UploadDeps => ({
  s3Client: mock.client,
  bucket: "test-bucket",
  now: () => FIXED_NOW,
});

describe("uploadRun — happy path", () => {
  it("uploads summary, lightweight trials, compressed traces, and videos", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);

    writeFileSync(p.summaryPath, JSON.stringify({ runId: "run-1", model: "x" }));
    const trial1 = makeTrial("t1");
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(trial1));
    writeFileSync(join(p.videosDir, "t1.mp4"), Buffer.from("fake video"));

    const mock = makeMockS3();
    const manifest = await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "example-experiment",
      arm: "arm-a",
      deps: fixedDeps(mock),
    });

    const keys = mock.puts.map((p) => p.key).sort();
    expect(keys).toEqual([
      "runs/run-1/summary.json",
      "runs/run-1/trials/t1.json",
      "traces/run-1/t1.json.zst",
      "videos/run-1/t1.mp4",
    ]);

    expect(manifest.runId).toBe("run-1");
    expect(manifest.evalSet).toBe("example-experiment");
    expect(manifest.arm).toBe("arm-a");
    expect(manifest.compression).toBe("zstd");
    expect(manifest.uploadedAt).toBe(FIXED_NOW.toISOString());
    expect(manifest.bucket).toBe("test-bucket");
    expect(manifest.trials.t1.trace).toBe("traces/run-1/t1.json.zst");
    expect(manifest.trials.t1.video).toBe("videos/run-1/t1.mp4");
    expect(manifest.trials.t1.traceBytes).toBeGreaterThan(0);
    expect(manifest.trials.t1.videoBytes).toBe("fake video".length);
  });

  it("uploads the lightweight trial (no trace, no parts)", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({ runId: "run-1" }));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));

    const mock = makeMockS3();
    await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    const trialPut = mock.puts.find((p) => p.key === "runs/run-1/trials/t1.json")!;
    const uploaded = JSON.parse(trialPut.body.toString("utf-8"));
    expect(uploaded.trace).toEqual([]);
    expect(uploaded.parts).toBeUndefined();
    expect(uploaded.taskId).toBe("t1");
  });

  it("uploads the compressed trace as decompressible zstd containing the original heavy fields", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    const trial = makeTrial("t1");
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(trial));

    const mock = makeMockS3();
    await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    const tracePut = mock.puts.find((p) => p.key === "traces/run-1/t1.json.zst")!;
    const decompressed = decompress(tracePut.body, "zstd");
    const fullTrace = JSON.parse(decompressed.toString("utf-8"));
    expect(fullTrace.taskId).toBe("t1");
    expect(fullTrace.trace).toEqual(trial.trace);
    expect(fullTrace.parts).toEqual(trial.parts);
  });

  it("rewrites the local trial file as the lightweight version", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));

    const mock = makeMockS3();
    await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    const onDisk = JSON.parse(readFileSync(join(p.trialsDir, "t1.json"), "utf-8"));
    expect(onDisk.trace).toEqual([]);
    expect(onDisk.parts).toBeUndefined();
  });

  it("writes manifest.json to the run dir after upload", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));

    const mock = makeMockS3();
    await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    expect(existsSync(p.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(p.manifestPath, "utf-8"));
    expect(manifest.runId).toBe("run-1");
  });

  it("deletes local videos dir after a successful upload (default cleanup=true)", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));
    writeFileSync(join(p.videosDir, "t1.mp4"), Buffer.from("v"));

    const mock = makeMockS3();
    await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    expect(existsSync(p.videosDir)).toBe(false);
  });

  it("preserves local videos dir when cleanup=false", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));
    writeFileSync(join(p.videosDir, "t1.mp4"), Buffer.from("v"));

    const mock = makeMockS3();
    await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      cleanup: false,
      deps: fixedDeps(mock),
    });

    expect(existsSync(p.videosDir)).toBe(true);
    expect(existsSync(join(p.videosDir, "t1.mp4"))).toBe(true);
  });
});

describe("uploadRun — multi-trial", () => {
  it("handles trials with and without videos in the same run", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "with-video.json"), JSON.stringify(makeTrial("with-video")));
    writeFileSync(join(p.trialsDir, "no-video.json"), JSON.stringify(makeTrial("no-video")));
    writeFileSync(join(p.videosDir, "with-video.mp4"), Buffer.from("v"));

    const mock = makeMockS3();
    const manifest = await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    expect(manifest.trials["with-video"].video).toBe("videos/run-1/with-video.mp4");
    expect(manifest.trials["no-video"].video).toBeUndefined();
  });

  it("uses the actual video extension on disk (.webm fallback when ffmpeg conversion didn't run)", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));
    writeFileSync(join(p.videosDir, "t1.webm"), Buffer.from("v"));

    const mock = makeMockS3();
    const manifest = await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    expect(manifest.trials.t1.video).toBe("videos/run-1/t1.webm");
    const videoKeys = mock.puts.map((p) => p.key).filter((k) => k.startsWith("videos/"));
    expect(videoKeys).toEqual(["videos/run-1/t1.webm"]);
  });

  it("prefers .mp4 over .webm when both exist (post-conversion sweep)", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));
    writeFileSync(join(p.videosDir, "t1.mp4"), Buffer.from("mp4 bytes"));
    writeFileSync(join(p.videosDir, "t1.webm"), Buffer.from("webm bytes"));

    const mock = makeMockS3();
    const manifest = await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    expect(manifest.trials.t1.video).toBe("videos/run-1/t1.mp4");
    const videoKeys = mock.puts.map((p) => p.key).filter((k) => k.startsWith("videos/"));
    expect(videoKeys).toEqual(["videos/run-1/t1.mp4"]);
  });
});

describe("uploadRun — error paths", () => {
  it("propagates S3 errors and leaves local files intact", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));
    writeFileSync(join(p.videosDir, "t1.mp4"), Buffer.from("v"));

    const send = vi.fn(async () => {
      throw new Error("S3 unreachable");
    });
    const failingClient = { send } as unknown as S3Client;

    await expect(
      uploadRun({
        paths: p,
        runId: "run-1",
        evalSet: "x",
        arm: "y",
        deps: { s3Client: failingClient, bucket: "b", now: () => FIXED_NOW },
      }),
    ).rejects.toThrow(/S3 unreachable/);

    // Files preserved so the user can rerun.
    expect(existsSync(join(p.videosDir, "t1.mp4"))).toBe(true);
    expect(existsSync(p.manifestPath)).toBe(false);
  });
});

describe("uploadRun — atomic local rewrite (Option A)", () => {
  it("preserves the full local trial JSON when the trace PUT fails after the lightweight PUT succeeded", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    const trial = makeTrial("t1");
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(trial));

    // Fail only the trace PUT. The summary + lightweight trial PUTs succeed.
    const mock = makeMockS3((cmd) => cmd.input.Key?.startsWith("traces/") ?? false);

    await expect(
      uploadRun({
        paths: p,
        runId: "run-1",
        evalSet: "x",
        arm: "y",
        deps: fixedDeps(mock),
      }),
    ).rejects.toThrow(/simulated S3 failure/);

    // The local trial JSON must STILL contain the full trace + parts so a
    // future re-run can rebuild the trace blob from disk. If we'd already
    // rewritten it as lightweight, that data would be lost.
    const onDisk = JSON.parse(readFileSync(join(p.trialsDir, "t1.json"), "utf-8"));
    expect(onDisk.trace).toEqual(trial.trace);
    expect(onDisk.parts).toEqual(trial.parts);
  });

  it("preserves the full local trial JSON when the video PUT fails after both prior PUTs succeeded", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    const trial = makeTrial("t1");
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(trial));
    writeFileSync(join(p.videosDir, "t1.mp4"), Buffer.from("v"));

    const mock = makeMockS3((cmd) => cmd.input.Key?.startsWith("videos/") ?? false);

    await expect(
      uploadRun({
        paths: p,
        runId: "run-1",
        evalSet: "x",
        arm: "y",
        deps: fixedDeps(mock),
      }),
    ).rejects.toThrow(/simulated S3 failure/);

    const onDisk = JSON.parse(readFileSync(join(p.trialsDir, "t1.json"), "utf-8"));
    expect(onDisk.trace).toEqual(trial.trace);
    expect(onDisk.parts).toEqual(trial.parts);
  });
});

describe("uploadRun — resume state (Option B)", () => {
  const STATE_FILENAME = ".upload-state.json";

  function statePath(runDir: string): string {
    return join(runDir, STATE_FILENAME);
  }

  it("writes the state file after each trial completes and removes it on full success", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "t1.json"), JSON.stringify(makeTrial("t1")));

    const mock = makeMockS3();
    await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    // After full success the state file is gone — the manifest is now the
    // source of truth.
    expect(existsSync(statePath(runDir))).toBe(false);
    expect(existsSync(p.manifestPath)).toBe(true);
  });

  it("persists per-trial progress when failure occurs mid-sweep", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "a.json"), JSON.stringify(makeTrial("a")));
    writeFileSync(join(p.trialsDir, "b.json"), JSON.stringify(makeTrial("b")));

    // Fail the SECOND trial's lightweight PUT (after `a` is fully done).
    const mock = makeMockS3((cmd) => cmd.input.Key === "runs/run-1/trials/b.json");

    await expect(
      uploadRun({
        paths: p,
        runId: "run-1",
        evalSet: "x",
        arm: "y",
        deps: fixedDeps(mock),
      }),
    ).rejects.toThrow();

    expect(existsSync(statePath(runDir))).toBe(true);
    const state = JSON.parse(readFileSync(statePath(runDir), "utf-8"));
    expect(state.runId).toBe("run-1");
    expect(state.summaryUploaded).toBe(true);
    expect(Object.keys(state.trials)).toEqual(["a"]);
    expect(state.trials.a.trace).toBe("traces/run-1/a.json.zst");
  });

  it("skips trials already recorded in the state file on resume", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "a.json"), JSON.stringify(makeTrial("a")));
    writeFileSync(join(p.trialsDir, "b.json"), JSON.stringify(makeTrial("b")));

    // Pre-seed state as if `a` was already uploaded successfully.
    writeFileSync(
      statePath(runDir),
      JSON.stringify({
        runId: "run-1",
        evalSet: "x",
        arm: "y",
        bucket: "test-bucket",
        compression: "zstd",
        summaryUploaded: true,
        trials: {
          a: {
            trace: "traces/run-1/a.json.zst",
            traceBytes: 999,
          },
        },
      }),
    );

    const mock = makeMockS3();
    const manifest = await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(mock),
    });

    // Only the keys for trial `b` should have been PUT this time.
    const keys = mock.puts.map((p) => p.key).sort();
    expect(keys).toEqual([
      "runs/run-1/trials/b.json",
      "traces/run-1/b.json.zst",
    ]);

    // The manifest still includes both trials — `a` from preserved state,
    // `b` from this run.
    expect(Object.keys(manifest.trials).sort()).toEqual(["a", "b"]);
    expect(manifest.trials.a.traceBytes).toBe(999);
  });

  it("throws when the state file's runId/evalSet/arm/bucket/compression don't match the current invocation", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({}));
    writeFileSync(join(p.trialsDir, "a.json"), JSON.stringify(makeTrial("a")));

    writeFileSync(
      statePath(runDir),
      JSON.stringify({
        runId: "wrong-run",
        evalSet: "x",
        arm: "y",
        bucket: "test-bucket",
        compression: "zstd",
        summaryUploaded: true,
        trials: {},
      }),
    );

    const mock = makeMockS3();
    await expect(
      uploadRun({
        paths: p,
        runId: "run-1",
        evalSet: "x",
        arm: "y",
        deps: fixedDeps(mock),
      }),
    ).rejects.toThrow(/upload state.*does not match/i);
  });

  it("end-to-end: a partial failure followed by a full retry produces the same manifest as a single clean run", async () => {
    const runDir = makeRunDir();
    trackForCleanup(runDir);
    const p = paths(runDir);
    writeFileSync(p.summaryPath, JSON.stringify({ runId: "run-1" }));
    writeFileSync(join(p.trialsDir, "a.json"), JSON.stringify(makeTrial("a")));
    writeFileSync(join(p.trialsDir, "b.json"), JSON.stringify(makeTrial("b")));
    writeFileSync(join(p.videosDir, "a.mp4"), Buffer.from("vid-a"));
    writeFileSync(join(p.videosDir, "b.mp4"), Buffer.from("vid-b"));

    // First attempt: fail on b's video PUT.
    const failingMock = makeMockS3(
      (cmd) => cmd.input.Key === "videos/run-1/b.mp4",
    );
    await expect(
      uploadRun({
        paths: p,
        runId: "run-1",
        evalSet: "x",
        arm: "y",
        deps: fixedDeps(failingMock),
      }),
    ).rejects.toThrow();

    expect(existsSync(statePath(runDir))).toBe(true);
    expect(existsSync(p.manifestPath)).toBe(false);

    // Second attempt: same params, no failure injection.
    const goodMock = makeMockS3();
    const manifest = await uploadRun({
      paths: p,
      runId: "run-1",
      evalSet: "x",
      arm: "y",
      deps: fixedDeps(goodMock),
    });

    // State file removed; manifest written.
    expect(existsSync(statePath(runDir))).toBe(false);
    expect(existsSync(p.manifestPath)).toBe(true);

    // Both trials present.
    expect(Object.keys(manifest.trials).sort()).toEqual(["a", "b"]);
    expect(manifest.trials.a.video).toBe("videos/run-1/a.mp4");
    expect(manifest.trials.b.video).toBe("videos/run-1/b.mp4");

    // The second attempt did NOT re-PUT keys we'd already finished. `a` was
    // entirely uploaded in the first attempt, so the second attempt should
    // skip it. Only `b`'s keys should be in the second attempt's puts.
    const secondKeys = goodMock.puts.map((p) => p.key).sort();
    expect(secondKeys).toEqual([
      "runs/run-1/trials/b.json",
      "traces/run-1/b.json.zst",
      "videos/run-1/b.mp4",
    ]);
  });
});
