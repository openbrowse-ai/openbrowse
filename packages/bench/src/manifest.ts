/**
 * Pure manifest construction + R2 key derivation.
 *
 * The manifest is the post-upload metadata file: it records which task →
 * which R2 key, plus byte sizes (sanity-check for re-downloads) and the
 * compression algorithm used. It's small enough to commit alongside
 * other run metadata for traceability.
 *
 * Key derivation is centralized here so callers (uploader, fetch helper,
 * migration script) can't drift on the layout.
 */

import type { CompressionAlgo } from "./compress";

export type VideoExt = "mp4" | "webm";

const COMPRESSION_EXT: Record<CompressionAlgo, string> = {
  zstd: ".json.zst",
  gzip: ".json.gz",
};

export interface R2Keys {
  /** `runs/<runId>/trials/<taskId>.json` (lightweight trial JSON). */
  trial: string;
  /** `traces/<runId>/<taskId>.<ext>` (compressed full trace). */
  trace: string;
  /** `videos/<runId>/<taskId>.<videoExt>`. */
  video: string;
  /** `runs/<runId>/summary.json`. */
  summary: string;
}

/** Compute the R2 keys for a given run + (optional) task. */
export function r2KeysFor(opts: {
  runId: string;
  /** Pass `null` when only the summary key is needed. */
  taskId: string | null;
  compressionAlgo: CompressionAlgo;
  videoExt: VideoExt;
}): R2Keys {
  const { runId, taskId, compressionAlgo, videoExt } = opts;
  const traceExt = COMPRESSION_EXT[compressionAlgo];
  const tid = taskId ?? "";
  return {
    trial: `runs/${runId}/trials/${tid}.json`,
    trace: `traces/${runId}/${tid}${traceExt}`,
    video: `videos/${runId}/${tid}.${videoExt}`,
    summary: `runs/${runId}/summary.json`,
  };
}

export interface ManifestTrialUpload {
  taskId: string;
  traceKey: string;
  traceBytes: number;
  /** Null when the trial had no video (e.g. `--no-video`). */
  videoKey: string | null;
  videoBytes: number | null;
}

export interface ManifestTrialEntry {
  trace: string;
  traceBytes: number;
  /** Omitted when the trial had no video. */
  video?: string;
  videoBytes?: number;
}

export interface Manifest {
  runId: string;
  evalSet: string;
  arm: string;
  uploadedAt: string;
  bucket: string;
  compression: CompressionAlgo;
  trials: Record<string, ManifestTrialEntry>;
}

export function buildManifest(opts: {
  runId: string;
  evalSet: string;
  arm: string;
  bucket: string;
  compression: CompressionAlgo;
  uploadedAt: string;
  uploads: ManifestTrialUpload[];
}): Manifest {
  const trials: Record<string, ManifestTrialEntry> = {};
  for (const u of opts.uploads) {
    if (trials[u.taskId]) {
      throw new Error(`duplicate taskId in uploads: ${u.taskId}`);
    }
    const entry: ManifestTrialEntry = {
      trace: u.traceKey,
      traceBytes: u.traceBytes,
    };
    if (u.videoKey !== null) {
      entry.video = u.videoKey;
      entry.videoBytes = u.videoBytes ?? 0;
    }
    trials[u.taskId] = entry;
  }
  return {
    runId: opts.runId,
    evalSet: opts.evalSet,
    arm: opts.arm,
    uploadedAt: opts.uploadedAt,
    bucket: opts.bucket,
    compression: opts.compression,
    trials,
  };
}
