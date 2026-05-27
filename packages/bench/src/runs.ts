/**
 * Pure split / merge for `TrialResult`.
 *
 * The bench writes one JSON per trial. When uploading to R2 we want to
 * separate the "lightweight" metadata (small, queryable, kept locally and
 * uploaded to `runs/<run-id>/trials/`) from the "full trace" (heavy:
 * `trace[]` and `parts[]`, uploaded to `traces/<run-id>/`, deleted locally
 * after upload).
 *
 * Both halves are JSON-serializable plain objects. No I/O.
 */

import type { TrialResult, TraceEntry } from "./runner";

/**
 * Trial JSON sans the heavy fields. Identical shape to `TrialResult` so
 * downstream consumers (summary aggregation, `readAllTrials()`) can keep
 * treating it as a `TrialResult`. `trace` is set to `[]` rather than
 * dropped to preserve the type contract.
 */
export type LightweightTrial = TrialResult;

/**
 * The two heavy fields, isolated. Carries `taskId` for cross-checking
 * during merge so a misrouted trace can never silently overwrite the
 * wrong trial's data.
 */
export interface FullTrace {
  taskId: string;
  trace: TraceEntry[];
  parts: unknown[];
}

/**
 * Split a trial into a lightweight half (kept locally + uploaded to
 * `runs/`) and a full-trace half (uploaded to `traces/`, deleted locally).
 */
export function splitTrial(trial: TrialResult): {
  lightweight: LightweightTrial;
  fullTrace: FullTrace;
} {
  const fullTrace: FullTrace = {
    taskId: trial.taskId,
    // Deep-ish copy via structuredClone so callers can't observe later
    // mutations on the original. JSON-safe so structuredClone is fine.
    trace: structuredClone(trial.trace),
    parts: structuredClone(trial.parts ?? []),
  };

  const lightweight: LightweightTrial = {
    ...trial,
    trace: [],
  };
  delete lightweight.parts;

  return { lightweight, fullTrace };
}

/**
 * Reverse of `splitTrial`. Throws if the two halves disagree on `taskId`.
 */
export function mergeTrial(
  lightweight: LightweightTrial,
  fullTrace: FullTrace,
): TrialResult {
  if (lightweight.taskId !== fullTrace.taskId) {
    throw new Error(
      `mergeTrial: taskId mismatch (lightweight=${lightweight.taskId}, fullTrace=${fullTrace.taskId})`,
    );
  }
  return {
    ...lightweight,
    trace: structuredClone(fullTrace.trace),
    parts: structuredClone(fullTrace.parts),
  };
}
