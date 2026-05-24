/**
 * Video post-processing utilities.
 *
 * Playwright records WebM (VP8 in Matroska) only. To produce MP4 we shell
 * out to `ffmpeg` after the sweep finishes — running conversions during a
 * trial would inflate per-trial wall time and pollute the timing data.
 *
 * Per the eval-harness spec's resolved decisions: MP4 is the default,
 * .webm originals are deleted after a successful conversion. If ffmpeg
 * isn't on PATH we surface a friendly warning and leave the .webm files
 * intact so the user can still review them.
 */

import { spawn } from "node:child_process";
import { readdir, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

/** True when `ffmpeg --version` succeeds with exit code 0. */
export async function ffmpegAvailable(): Promise<boolean> {
  return await new Promise<boolean>((resolveBool) => {
    try {
      const child = spawn("ffmpeg", ["-hide_banner", "-version"], {
        stdio: "ignore",
      });
      child.once("error", () => resolveBool(false));
      child.once("exit", (code) => resolveBool(code === 0));
    } catch {
      resolveBool(false);
    }
  });
}

interface ConvertOptions {
  /** When true, delete the source .webm after a successful conversion. */
  deleteSource?: boolean;
  /** Constant Rate Factor for libx264. Lower = better quality. Default 23. */
  crf?: number;
  /** libx264 preset. Default `fast` — good size/quality/speed balance. */
  preset?: string;
}

export interface ConvertResult {
  source: string;
  target: string;
  ok: boolean;
  /** Set when `ok=false` and ffmpeg's stderr was captured. */
  stderr?: string;
}

/**
 * Convert one .webm to mp4. Resolves with an `ok: false` result on
 * failure; never throws so a bad input file doesn't kill a batch.
 */
export function convertWebmToMp4(
  source: string,
  opts: ConvertOptions = {},
): Promise<ConvertResult> {
  const target = source.replace(/\.webm$/i, ".mp4");
  const crf = (opts.crf ?? 23).toString();
  const preset = opts.preset ?? "fast";
  return new Promise<ConvertResult>((res) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      crf,
      "-movflags",
      "+faststart",
      "-an",
      target,
    ];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", () => res({ source, target, ok: false, stderr }));
    child.once("exit", async (code) => {
      const ok = code === 0;
      if (ok && opts.deleteSource) {
        await unlink(source).catch(() => {});
      }
      res({ source, target, ok, stderr: ok ? undefined : stderr });
    });
  });
}

/**
 * Convert every .webm in a directory in parallel (capped at `concurrency`
 * to avoid swamping CPU). Returns one result per input file. Files that
 * already have a sibling .mp4 newer than the .webm are skipped.
 */
export async function convertAllInDir(
  dir: string,
  opts: ConvertOptions & { concurrency?: number } = {},
): Promise<ConvertResult[]> {
  const concurrency = opts.concurrency ?? 4;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const sources: string[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".webm")) continue;
    const sourcePath = resolve(dir, name);
    const targetPath = sourcePath.replace(/\.webm$/i, ".mp4");
    // Skip when an mp4 already exists and is newer than the source —
    // useful for re-running the sweep CLI without re-encoding.
    try {
      const [s, t] = await Promise.all([stat(sourcePath), stat(targetPath)]);
      if (t.mtimeMs >= s.mtimeMs) continue;
    } catch {
      // mp4 missing: proceed with conversion
    }
    sources.push(sourcePath);
  }

  const results: ConvertResult[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < sources.length) {
      const i = cursor++;
      const r = await convertWebmToMp4(sources[i], opts);
      results.push(r);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, sources.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
