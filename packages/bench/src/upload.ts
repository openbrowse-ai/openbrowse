/**
 * R2 upload pipeline.
 *
 * Given a fully-written run directory (`<runDir>/summary.json`, per-trial
 * JSONs in `<runDir>/trials/`, optional videos in `<runDir>/videos/`),
 * `uploadRun` will:
 *
 *   1. Walk trials and, for each one, PUT the lightweight half to
 *      `runs/<runId>/trials/<task-id>.json`, the zstd-compressed full
 *      trace to `traces/<runId>/<task-id>.json.zst`, and the video (if
 *      any) to `videos/<runId>/<task-id>.<ext>`. Prefers `.mp4` over
 *      `.webm` when both exist (post-ffmpeg-conversion case).
 *   2. Only AFTER all three PUTs for a trial have succeeded does it
 *      rewrite the local trial JSON in place as the lightweight version.
 *      This preserves the on-disk full trace + parts until R2 has its
 *      own copy, so any failure mid-trial is recoverable by simply
 *      re-running.
 *   3. PUT the run-level `summary.json` to `runs/<runId>/summary.json`
 *      first (small, surfaces auth failures fast).
 *   4. Build a manifest from the upload metadata, write it to
 *      `<runDir>/manifest.json`.
 *   5. Optionally clean up local heavies (default on): remove the
 *      `videos/` dir.
 *
 * Resume support
 * --------------
 *
 * Per-trial progress is persisted to `<runDir>/.upload-state.json` after
 * each successful trial. If `uploadRun` is invoked again on the same run
 * dir (because a previous attempt crashed mid-sweep), the state file is
 * consulted: trials already recorded as complete are skipped, and only
 * the remaining ones are uploaded. The state file is removed on full
 * success — `manifest.json` then becomes the source of truth.
 *
 * The state file's schema records the run's identity (`runId`, `evalSet`,
 * `arm`, `bucket`, `compression`). If any of those don't match the
 * current invocation, `uploadRun` throws to prevent silently mixing two
 * different runs' artifacts. Manually delete the state file to start
 * fresh.
 *
 * The S3 client is injected so tests can mock without a real network. In
 * production, callers construct a real client from R2 env vars (see
 * `createR2Client`).
 */

import {
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { compress, type CompressionAlgo } from "./compress";
import {
  buildManifest,
  r2KeysFor,
  type Manifest,
  type ManifestTrialEntry,
  type ManifestTrialUpload,
  type VideoExt,
} from "./manifest";
import type { RunPaths } from "./paths";
import { splitTrial } from "./runs";
import type { TrialResult } from "./runner";

export interface UploadDeps {
  s3Client: S3Client;
  bucket: string;
  /** Override the manifest's `uploadedAt` for deterministic tests. */
  now?: () => Date;
}

export interface UploadOpts {
  paths: RunPaths;
  runId: string;
  evalSet: string;
  arm: string;
  /** Compression algorithm for trace blobs. Default: zstd. */
  compression?: CompressionAlgo;
  /** Delete local heavies after success. Default: true. */
  cleanup?: boolean;
  deps: UploadDeps;
}

/**
 * Construct an S3 client pointed at Cloudflare R2 from env vars. Throws
 * if any required var is missing — callers should detect upload-enabled
 * mode via `r2EnvPresent()` first.
 */
export function createR2Client(env: NodeJS.ProcessEnv = process.env): {
  client: S3Client;
  bucket: string;
} {
  const accountId = env.R2_ACCOUNT_ID;
  const endpoint = env.R2_ENDPOINT;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  const missing = Object.entries({
    R2_ACCOUNT_ID: accountId,
    R2_ENDPOINT: endpoint,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
    R2_BUCKET: bucket,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `createR2Client: missing required R2 env vars: ${missing.join(", ")}`,
    );
  }
  const config: S3ClientConfig = {
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
    },
  };
  return { client: new S3Client(config), bucket: bucket! };
}

/** True when every required R2 env var is set. */
export function r2EnvPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    !!env.R2_ACCOUNT_ID &&
    !!env.R2_ENDPOINT &&
    !!env.R2_ACCESS_KEY_ID &&
    !!env.R2_SECRET_ACCESS_KEY &&
    !!env.R2_BUCKET
  );
}

interface VideoOnDisk {
  taskId: string;
  ext: VideoExt;
  absPath: string;
  bytes: number;
}

/** Index videosDir → preferred-extension lookup table by taskId. */
function indexVideos(videosDir: string): Map<string, VideoOnDisk> {
  const out = new Map<string, VideoOnDisk>();
  if (!existsSync(videosDir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(videosDir);
  } catch {
    return out;
  }
  // Two passes: collect mp4s first (preferred), then webms only if no mp4
  // exists for that taskId.
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".mp4")) continue;
    const taskId = name.replace(/\.mp4$/i, "");
    const absPath = join(videosDir, name);
    const bytes = readFileSync(absPath).byteLength;
    out.set(taskId, { taskId, ext: "mp4", absPath, bytes });
  }
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".webm")) continue;
    const taskId = name.replace(/\.webm$/i, "");
    if (out.has(taskId)) continue;
    const absPath = join(videosDir, name);
    const bytes = readFileSync(absPath).byteLength;
    out.set(taskId, { taskId, ext: "webm", absPath, bytes });
  }
  return out;
}

async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Buffer,
  contentType?: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Side-table state written incrementally during an upload to support
 * resume on partial failure. Schema mirrors the eventual `Manifest`,
 * minus `uploadedAt` (which only meaningful once the entire upload
 * succeeds).
 */
interface UploadState {
  runId: string;
  evalSet: string;
  arm: string;
  bucket: string;
  compression: CompressionAlgo;
  /** True once `runs/<runId>/summary.json` is in R2. */
  summaryUploaded: boolean;
  /** Per-task entries, populated only after all of a trial's PUTs succeed. */
  trials: Record<string, ManifestTrialEntry>;
}

const STATE_FILENAME = ".upload-state.json";

function uploadStatePath(paths: RunPaths): string {
  return join(paths.runDir, STATE_FILENAME);
}

function readUploadState(paths: RunPaths): UploadState | null {
  const path = uploadStatePath(paths);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as UploadState;
}

/**
 * Atomically write the state file via tmp + rename so a crash mid-write
 * can never leave a corrupt half-written JSON behind.
 */
function writeUploadState(paths: RunPaths, state: UploadState): void {
  const path = uploadStatePath(paths);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function deleteUploadState(paths: RunPaths): void {
  const path = uploadStatePath(paths);
  if (existsSync(path)) unlinkSync(path);
}

export async function uploadRun(opts: UploadOpts): Promise<Manifest> {
  const { paths, runId, evalSet, arm, deps } = opts;
  const compression: CompressionAlgo = opts.compression ?? "zstd";
  const cleanup = opts.cleanup ?? true;
  const now = deps.now ?? (() => new Date());

  // Try to resume from a previous partial upload.
  const existing = readUploadState(paths);
  let state: UploadState;
  if (existing) {
    if (
      existing.runId !== runId ||
      existing.evalSet !== evalSet ||
      existing.arm !== arm ||
      existing.bucket !== deps.bucket ||
      existing.compression !== compression
    ) {
      throw new Error(
        `upload state in ${uploadStatePath(paths)} does not match current ` +
          `invocation (runId/evalSet/arm/bucket/compression). Delete the ` +
          `state file to start fresh, or re-invoke with matching parameters.`,
      );
    }
    state = existing;
  } else {
    state = {
      runId,
      evalSet,
      arm,
      bucket: deps.bucket,
      compression,
      summaryUploaded: false,
      trials: {},
    };
  }

  // Upload summary first — small, and surfaces auth failures fast. Skip
  // if a previous attempt already completed it.
  if (!state.summaryUploaded) {
    const summaryBody = readFileSync(paths.summaryPath);
    const summaryKey = r2KeysFor({
      runId,
      taskId: null,
      compressionAlgo: compression,
      videoExt: "mp4",
    }).summary;
    await putObject(
      deps.s3Client,
      deps.bucket,
      summaryKey,
      summaryBody,
      "application/json",
    );
    state.summaryUploaded = true;
    writeUploadState(paths, state);
  }

  // Walk trials.
  const trialFiles = readdirSync(paths.trialsDir).filter((f) =>
    f.endsWith(".json"),
  );
  const videoIndex = indexVideos(paths.videosDir);

  for (const file of trialFiles) {
    const absPath = join(paths.trialsDir, file);
    const raw = readFileSync(absPath, "utf-8");
    const trial = JSON.parse(raw) as TrialResult;

    // Resume short-circuit.
    if (state.trials[trial.taskId]) continue;

    const { lightweight, fullTrace } = splitTrial(trial);
    const trialKeys = r2KeysFor({
      runId,
      taskId: trial.taskId,
      compressionAlgo: compression,
      videoExt: "mp4",
    });

    // PUT lightweight trial JSON.
    const lightweightBody = Buffer.from(
      JSON.stringify(lightweight, null, 2),
      "utf-8",
    );
    await putObject(
      deps.s3Client,
      deps.bucket,
      trialKeys.trial,
      lightweightBody,
      "application/json",
    );

    // PUT compressed full trace.
    const traceJson = Buffer.from(JSON.stringify(fullTrace), "utf-8");
    const { data: compressed } = compress(traceJson, { algo: compression });
    await putObject(
      deps.s3Client,
      deps.bucket,
      trialKeys.trace,
      compressed,
      "application/octet-stream",
    );

    // PUT video (if any).
    let videoKey: string | null = null;
    let videoBytes: number | null = null;
    const video = videoIndex.get(trial.taskId);
    if (video) {
      const videoKeys = r2KeysFor({
        runId,
        taskId: trial.taskId,
        compressionAlgo: compression,
        videoExt: video.ext,
      });
      const videoBody = readFileSync(video.absPath);
      await putObject(
        deps.s3Client,
        deps.bucket,
        videoKeys.video,
        videoBody,
        video.ext === "mp4" ? "video/mp4" : "video/webm",
      );
      videoKey = videoKeys.video;
      videoBytes = video.bytes;
    }

    // All cloud PUTs for this trial succeeded. NOW it's safe to:
    //   1. Rewrite the local trial JSON as lightweight (R2 has the heavy
    //      half so loss of the on-disk copy is no longer a concern).
    //   2. Mark the trial as complete in the state file.
    writeFileSync(
      absPath,
      JSON.stringify(lightweight, null, 2) + "\n",
      "utf-8",
    );

    const entry: ManifestTrialEntry = {
      trace: trialKeys.trace,
      traceBytes: compressed.byteLength,
    };
    if (videoKey !== null) {
      entry.video = videoKey;
      entry.videoBytes = videoBytes ?? 0;
    }
    state.trials[trial.taskId] = entry;
    writeUploadState(paths, state);
  }

  // All trials done. Build the manifest from the now-complete state.
  const uploads: ManifestTrialUpload[] = Object.entries(state.trials).map(
    ([taskId, entry]) => ({
      taskId,
      traceKey: entry.trace,
      traceBytes: entry.traceBytes,
      videoKey: entry.video ?? null,
      videoBytes: entry.videoBytes ?? null,
    }),
  );
  const manifest = buildManifest({
    runId: state.runId,
    evalSet: state.evalSet,
    arm: state.arm,
    bucket: state.bucket,
    compression: state.compression,
    uploadedAt: now().toISOString(),
    uploads,
  });

  writeFileSync(
    paths.manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );

  // Manifest is now the source of truth — drop the side table.
  deleteUploadState(paths);

  if (cleanup) {
    if (existsSync(paths.videosDir)) {
      rmSync(paths.videosDir, { recursive: true, force: true });
    }
  }

  return manifest;
}
