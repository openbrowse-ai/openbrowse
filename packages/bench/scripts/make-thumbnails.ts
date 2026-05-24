/**
 * Generate a contact-sheet thumbnail grid from a recorded trial video so
 * you can spot click rings / typing tooltips at a glance without watching
 * the whole video.
 *
 * Usage:
 *   pnpm exec tsx scripts/make-thumbnails.ts <video-or-run-dir>
 *
 * Examples:
 *   pnpm exec tsx scripts/make-thumbnails.ts \
 *     .bench/runs/2026-05-22T07-11-28-gemini-3-flash-preview-Apple--13/videos/Apple--13.mp4
 *
 *   pnpm exec tsx scripts/make-thumbnails.ts \
 *     .bench/runs/2026-05-22T07-11-28-gemini-3-flash-preview-Apple--13/
 *
 * Output: a `<source>-thumbnails.png` file alongside each input video.
 * Grid is 4x4 (16 frames) sampled evenly across the duration.
 */

import { spawn } from "node:child_process";
import { stat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

async function probeDuration(path: string): Promise<number> {
  return new Promise<number>((res) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]);
    let buf = "";
    child.stdout.on("data", (c) => (buf += c.toString()));
    child.once("error", () => res(0));
    child.once("exit", () => res(parseFloat(buf.trim()) || 0));
  });
}

async function makeGrid(videoPath: string): Promise<void> {
  const out = videoPath.replace(/\.(mp4|webm)$/i, "-thumbnails.png");
  const duration = await probeDuration(videoPath);
  // Aim for 16 frames spread across the duration. ffmpeg's `fps` filter
  // takes a frequency, so divide.
  const fps = duration > 0 ? Math.max(0.1, 16 / duration) : 0.5;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-vf",
    `fps=${fps},scale=480:-1,tile=4x4`,
    "-frames:v",
    "1",
    out,
  ];
  await new Promise<void>((res, rej) => {
    const child = spawn("ffmpeg", args, { stdio: "inherit" });
    child.once("error", rej);
    child.once("exit", (code) =>
      code === 0
        ? res()
        : rej(new Error(`ffmpeg exit ${code}`)),
    );
  });
  console.log(`  -> ${out}`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: make-thumbnails.ts <video-or-run-dir>");
    process.exit(2);
  }
  const path = resolve(arg);
  const s = await stat(path);
  if (s.isFile()) {
    await makeGrid(path);
    return;
  }
  if (s.isDirectory()) {
    // Walk the dir looking for .mp4 / .webm. Looks for a `videos/` subdir
    // first (matches our run-dir layout) then falls back to the dir itself.
    const videoDir = await stat(resolve(path, "videos"))
      .then(() => resolve(path, "videos"))
      .catch(() => path);
    const entries = await readdir(videoDir);
    const videos = entries
      .filter((n) => /\.(mp4|webm)$/i.test(n))
      .filter((n) => !n.includes("-thumbnails."));
    if (videos.length === 0) {
      console.error(`No videos found in ${videoDir}`);
      process.exit(1);
    }
    for (const name of videos) {
      console.log(`Processing ${name}...`);
      await makeGrid(resolve(videoDir, name));
    }
    return;
  }
  console.error(`Not a file or directory: ${path}`);
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
