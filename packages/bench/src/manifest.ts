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

export interface R2TrialKeys {
  /** `runs/<runId>/trials/<taskId>.json` (lightweight trial JSON). */
  trial: string;
  /** `traces/<runId>/<taskId>.<ext>` (compressed full trace). */
  trace: string;
  /** `videos/<runId>/<taskId>.<videoExt>`. */
  video: string;
}

/** Compute the per-trial R2 keys. */
export function r2TrialKeys(opts: {
  runId: string;
  taskId: string;
  compressionAlgo: CompressionAlgo;
  videoExt: VideoExt;
}): R2TrialKeys {
  const { runId, taskId, compressionAlgo, videoExt } = opts;
  const traceExt = COMPRESSION_EXT[compressionAlgo];
  return {
    trial: `runs/${runId}/trials/${taskId}.json`,
    trace: `traces/${runId}/${taskId}${traceExt}`,
    video: `videos/${runId}/${taskId}.${videoExt}`,
  };
}

/** Compute the run-level summary key. */
export function r2SummaryKey(runId: string): string {
  return `runs/${runId}/summary.json`;
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
      if (u.videoBytes == null || u.videoBytes < 0) {
        throw new Error(
          `videoKey set but videoBytes missing/invalid for taskId=${u.taskId} (got ${u.videoBytes})`,
        );
      }
      entry.video = u.videoKey;
      entry.videoBytes = u.videoBytes;
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
