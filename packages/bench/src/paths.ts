/**
 * Filesystem paths for bench artifacts.
 *
 * All bench output lives under `<repo-root>/.bench/`:
 *
 *   .bench/
 *   └── runs/
 *       └── <runId>/
 *           ├── summary.json
 *           ├── trials/<task-id>.json
 *           └── videos/<task-id>.{webm,mp4}
 *
 * Each invocation of the CLI gets a fresh `runId` of the form
 * `<iso-timestamp>-<model-label>-<suite-or-task>` so concurrent or
 * sequential runs never overlap.
 *
 * Repo-root is found by walking up from this file looking for
 * `pnpm-workspace.yaml`, the same heuristic `env.ts` uses. We import that
 * helper rather than duplicate it.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findWorkspaceRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Absolute path to the repo's `.bench/` directory. Created on demand. */
export function benchRoot(): string {
  const root = findWorkspaceRoot(__dirname) ?? resolve(__dirname, "..");
  return resolve(root, ".bench");
}

/** Sanitize a string fragment for use in a filesystem path. */
export function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9-_.]/g, "_");
}

/** Generate a stable per-run directory id. */
export function makeRunId(opts: {
  modelLabel: string;
  suite?: string;
  taskId?: string;
}): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tail = opts.suite ?? opts.taskId ?? "task";
  return `${stamp}-${safeSegment(opts.modelLabel)}-${safeSegment(tail)}`;
}

export interface RunPaths {
  /** e.g. `<root>/.bench/runs/2026-05-22T05-31-24-gemini-3-flash-preview-webbench-mini` */
  runDir: string;
  /** `<runDir>/trials` */
  trialsDir: string;
  /** `<runDir>/videos` */
  videosDir: string;
  /** `<runDir>/summary.json` */
  summaryPath: string;
}

/** Resolve the directory for a run, given either an explicit dir override
 *  (from `--out-dir`) or a generated runId (mounted under `.bench/runs/`). */
export function resolveRunDir(opts: {
  runId?: string;
  outDirOverride?: string;
}): string {
  if (opts.outDirOverride) {
    return resolve(opts.outDirOverride);
  }
  if (!opts.runId) {
    throw new Error("resolveRunDir: must pass either runId or outDirOverride");
  }
  return resolve(benchRoot(), "runs", opts.runId);
}

/**
 * Create the directory tree for a run and return the resolved paths.
 * Synchronous because we need the dirs to exist before the runner starts
 * issuing artifact writes from inside the agent loop.
 *
 * Accepts an absolute `runDir` so callers can route either through the
 * default `.bench/runs/<id>/` layout or an explicit `--out-dir`.
 */
export function createRunPaths(runDir: string): RunPaths {
  const trialsDir = resolve(runDir, "trials");
  const videosDir = resolve(runDir, "videos");
  mkdirSync(trialsDir, { recursive: true });
  mkdirSync(videosDir, { recursive: true });
  return {
    runDir,
    trialsDir,
    videosDir,
    summaryPath: resolve(runDir, "summary.json"),
  };
}
