/**
 * Tool-agnostic task definitions consumed by the bench harness.
 *
 * Tasks are deliberately small, declarative, and serializable: a task should
 * be expressible as JSON so external sources (WebVoyager, Mind2Web, GAIA) can
 * be imported with a thin transformer. The runner is responsible for setting
 * up the browser to the `startUrl` and feeding `instruction` to the agent.
 *
 * Evaluator selection is a discriminated union (vs. a flat `evaluator: string`
 * field) so each evaluator carries exactly the data it needs — no awkward
 * "expectedAnswer optional" types for evaluators that don't use it.
 */

export type EvaluatorSpec =
  | { kind: "exact-match"; expected: string; field?: string }
  | { kind: "url-match"; pattern: string }
  | {
      kind: "llm-judge";
      rubric: string;
      /** Optional ground truth handed to the judge alongside the rubric. */
      expectedAnswer?: string;
    };

export type TaskCategory =
  | "extraction"
  | "navigation"
  | "form"
  | "multi-step"
  | "research";

export type TaskSource =
  | "webbench"
  | "mind2web"
  | "gaia"
  | "browsecomp"
  | "custom";

export interface BenchmarkTask {
  id: string;
  instruction: string;
  startUrl: string;
  category: TaskCategory;
  source: TaskSource;
  evaluator: EvaluatorSpec;
  /** Hard timeout for the trial. Defaults to 5 minutes if omitted. */
  timeoutMs?: number;
  /** Cap on agent steps. Defaults to 40. */
  maxSteps?: number;
  /** Free-form notes for the curator; not consumed by the runner. */
  notes?: string;
  /**
   * Set when this task requires an authenticated session. 
   * The public runner ignores this field — tasks with `requiresAuth` should not be
   * exported from the public suite.
   */
  requiresAuth?: {
    profileName: string;
    domain: string;
  };
}
