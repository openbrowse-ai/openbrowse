/**
 * Disk persistence for trial results and run summaries.
 *
 * The bench writes one JSON per trial (under `<runDir>/trials/<task-id>.json`)
 * plus an aggregate `<runDir>/summary.json` once the sweep finishes. JSON
 * (not SQLite) for v1 because it's trivially diffable and readable; we can
 * graduate to SQLite later when matrix-scale runs make per-file overhead
 * matter.
 */

import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { TrialResult } from "./runner";
import { safeSegment, type RunPaths } from "./paths";

export interface RunSummary {
  runId: string;
  model: string;
  suite?: string;
  taskId?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  tasks: number;
  replicas: number;
  passed: number;
  passRate: number;
  /** Pass rate breakdown for deeper analysis. */
  breakdown?: {
    agentAccuracy: number;
    infrastructureFailureRate: number;
    judgeRejectRate: number;
  };
  /** Failure rate per domain to inform infrastructure tuning and exclusions. */
  failuresByDomain?: Record<string, number>;
  tokens: { in: number; out: number; total: number };
  /** Complete snapshot of the harness configuration used for this run. */
  harness?: {
    agent: {
      modelId: string;
      systemPromptId: string;
      systemPromptHash: string;
      systemPromptText: string;
      toolSet: {
        name: string;
        description: string;
        inputSchema: object;
        outputSchema?: object;
      }[];
      limits: {
        contextWindow: number;
        maxOutputTokens: number;
      };
    };
    driver: {
      kind: "local" | "kernel";
      headless: boolean;
      stealth?: boolean;
      visualize: boolean;
      viewport?: { width: number; height: number };
    };
    run: {
      concurrency: number;
      replicas: number;
      timeoutMs?: number;
    };
    judge: {
      modelId: string;
      version: string;
    };
    suite: {
      source?: string;
      revision?: string;
      totalTasks?: number;
      sampleSize?: number;
      seed?: number;
    };
    provenance: {
      benchVersion: string;
      gitSha?: string;
      nodeVersion: string;
      platform: string;
    };
  };
  /** Per-trial files relative to `runDir`. */
  trialPaths: string[];
}

/**
 * Write a single trial result. Returns the absolute path so the caller can
 * surface it in CLI output.
 */
export function writeTrial(paths: RunPaths, trial: TrialResult): string {
  const filename = `${safeSegment(trial.taskId)}.json`;
  const path = resolve(paths.trialsDir, filename);
  writeFileSync(path, JSON.stringify(trial, null, 2) + "\n", "utf-8");
  return path;
}

export function writeSummary(paths: RunPaths, summary: RunSummary): string {
  writeFileSync(
    paths.summaryPath,
    JSON.stringify(summary, null, 2) + "\n",
    "utf-8",
  );
  return paths.summaryPath;
}

export function readAllTrials(paths: RunPaths): TrialResult[] {
  const files = readdirSync(paths.trialsDir).filter((f) => f.endsWith(".json"));
  const trials: TrialResult[] = [];
  for (const f of files) {
    try {
      const data = readFileSync(join(paths.trialsDir, f), "utf-8");
      trials.push(JSON.parse(data));
    } catch (err) {
      console.warn(`Failed to read trial ${f}:`, err);
    }
  }
  return trials;
}
