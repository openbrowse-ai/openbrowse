import type { BenchmarkTask } from "../tasks/types";
import { exactMatch } from "./exact-match";
import { llmJudge, LLM_JUDGE_VERSION } from "./llm-judge";
import type { JudgeVerdict } from "./types";
import { urlMatch } from "./url-match";

export interface JudgeInput {
  task: BenchmarkTask;
  agentAnswer: string;
  finalUrl: string;
}

/**
 * Dispatch on the task's evaluator spec. Each kind picks the correct judge
 * and returns a uniform `JudgeVerdict`.
 */
export async function judge(input: JudgeInput): Promise<JudgeVerdict> {
  const ev = input.task.evaluator;
  switch (ev.kind) {
    case "exact-match":
      return exactMatch(input.agentAnswer, ev.expected);
    case "url-match":
      return urlMatch(input.finalUrl, ev.pattern);
    case "llm-judge":
      return await llmJudge({
        instruction: input.task.instruction,
        rubric: ev.rubric,
        expectedAnswer: ev.expectedAnswer,
        agentAnswer: input.agentAnswer,
      });
  }
}

export type { JudgeVerdict };
export { exactMatch, urlMatch, llmJudge, LLM_JUDGE_VERSION };
