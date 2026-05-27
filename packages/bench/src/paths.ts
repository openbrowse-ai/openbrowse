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

/** Generate a stable per-run directory id.
 *
 * Two shapes are supported:
 *
 * - Legacy (CLI default): `<ts>-<modelLabel>-<suite-or-task>`. Used when
 *   no `{ evalSet, arm }` pair is supplied.
 * - Experiment: `<ts>-<evalSet>-<arm>`. Used when an eval-set runner
 *   passes both fields through; the `modelLabel` is recorded in the run
 *   summary instead of the directory name (eval-sets fix the model per
 *   arm, so embedding it in every run-id would be redundant).
 */
export function makeRunId(opts: {
  modelLabel: string;
  suite?: string;
  taskId?: string;
  evalSet?: string;
  arm?: string;
}): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (opts.evalSet && opts.arm) {
    return `${stamp}-${safeSegment(opts.evalSet)}-${safeSegment(opts.arm)}`;
  }
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
  /** `<runDir>/traces` (created lazily; only used by the upload pipeline). */
  tracesDir: string;
  /** `<runDir>/summary.json` */
  summaryPath: string;
  /** `<runDir>/manifest.json` (written after a successful R2 upload). */
  manifestPath: string;
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
  const tracesDir = resolve(runDir, "traces");
  mkdirSync(trialsDir, { recursive: true });
  mkdirSync(videosDir, { recursive: true });
  // tracesDir is created on demand by the upload pipeline; reserve the
  // path here so callers don't need to know the layout.
  return {
    runDir,
    trialsDir,
    videosDir,
    tracesDir,
    summaryPath: resolve(runDir, "summary.json"),
    manifestPath: resolve(runDir, "manifest.json"),
  };
}

/**
 * Validate and resolve paths for an existing run directory (for resume).
 * Creates the videos directory if it somehow doesn't exist, but requires
 * the trials directory to already be there.
 */
export function ensureRunDirExists(runDir: string): RunPaths {
  const absoluteDir = resolve(runDir);
  if (!existsSync(absoluteDir)) {
    throw new Error(`ensureRunDirExists: directory does not exist: ${absoluteDir}`);
  }
  
  const trialsDir = resolve(absoluteDir, "trials");
  if (!existsSync(trialsDir)) {
    throw new Error(`ensureRunDirExists: not a valid run directory (missing 'trials' folder): ${absoluteDir}`);
  }
  
  const videosDir = resolve(absoluteDir, "videos");
  if (!existsSync(videosDir)) {
    mkdirSync(videosDir, { recursive: true });
  }

  const tracesDir = resolve(absoluteDir, "traces");

  return {
    runDir: absoluteDir,
    trialsDir,
    videosDir,
    tracesDir,
    summaryPath: resolve(absoluteDir, "summary.json"),
    manifestPath: resolve(absoluteDir, "manifest.json"),
  };
}
