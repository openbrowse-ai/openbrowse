/**
 * Shared judge types. A `JudgeVerdict` is the output every judge produces.
 * The runner stores the verdict alongside the trial result.
 */

export interface JudgeVerdict {
  passed: boolean;
  reasoning: string;
  /** Set by `llmJudge` so historical scores remain comparable across prompt versions. */
  judgeVersion?: string;
}
