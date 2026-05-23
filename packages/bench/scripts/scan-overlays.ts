/**
 * Scan extracted frames (or a video — auto-extracts) for the visual
 * signatures of our overlay system: click rings (rgba 59/130/246) and
 * typing tooltips (rgba 31/41/55). Useful when you want to programmatically
 * confirm the visualization driver fired during a trial without sitting
 * through the whole video.
 *
 * Usage:
 *   pnpm exec tsx scripts/scan-overlays.ts <video.mp4|video.webm|frame-dir>
 *
 * Caveats:
 *   - Tooltip dark color (31,41,55) collides with common page chrome
 *     (nav bars, dark buttons, modals). The scan reports per-frame counts
 *     so you can spot anomalies above baseline rather than absolute
 *     presence.
 *   - Click ring blue (59,130,246) is more distinctive but still not
 *     unique — Apple CTA buttons and a few other UI elements use similar
 *     hues. Treat single-frame hits as suggestive, multi-frame clusters
 *     as confirmed.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const RING = [59, 130, 246];
const TIP = [31, 41, 55];

function near(r: number, g: number, b: number, t: number[], tol: number): boolean {
  return (
    Math.abs(r - t[0]) < tol &&
    Math.abs(g - t[1]) < tol &&
    Math.abs(b - t[2]) < tol
  );
}

function scanDir(dir: string): void {
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".png"))
    .sort();
  if (files.length === 0) {
    console.log(`(no png files in ${dir})`);
    return;
  }
  // First pass: collect TIP counts to compute baseline. Anomalies = >2x median.
  const samples: { name: string; ring: number; tip: number }[] = [];
  for (const name of files) {
    const buf = readFileSync(resolve(dir, name));
    const png = PNG.sync.read(buf);
    const { width, height, data } = png;
    let ringHits = 0;
    let tipHits = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        const r = data[i],
          g = data[i + 1],
          b = data[i + 2];
        if (near(r, g, b, RING, 25)) ringHits++;
        if (near(r, g, b, TIP, 12)) tipHits++;
      }
    }
    samples.push({ name, ring: ringHits, tip: tipHits });
  }
  const tipMedian =
    samples.map((s) => s.tip).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const tipThreshold = Math.max(500, tipMedian * 2);

  console.log(`Scanned ${samples.length} frames (TIP baseline=${tipMedian}, anomaly>${tipThreshold})`);
  for (const s of samples) {
    const flags: string[] = [];
    if (s.ring > 30) flags.push(`RING(${s.ring})`);
    if (s.tip > tipThreshold) flags.push(`TIP*(${s.tip})`);
    if (flags.length) console.log(`  ${s.name}: ${flags.join(" ")}`);
  }
}

function extractFramesFromVideo(video: string, fps = 6): string {
  const dir = mkdtempSync(resolve(tmpdir(), "openbrowse-scan-"));
  spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      video,
      "-vf",
      `fps=${fps},scale=1280:-1`,
      resolve(dir, "f_%04d.png"),
    ],
    { stdio: "inherit" },
  );
  return dir;
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: scan-overlays.ts <video|frame-dir>");
    process.exit(2);
  }
  const path = resolve(arg);
  const s = statSync(path);
  if (s.isDirectory()) {
    scanDir(path);
    return;
  }
  // Treat as video — extract to temp dir first.
  if (/\.(mp4|webm|mov|mkv)$/i.test(path)) {
    console.log(`Extracting frames from ${path} at 6 fps...`);
    const tmp = extractFramesFromVideo(path, 6);
    console.log(`(temp dir: ${tmp})`);
    scanDir(tmp);
    return;
  }
  console.error(`Unsupported input: ${path}`);
  process.exit(2);
}

main();
