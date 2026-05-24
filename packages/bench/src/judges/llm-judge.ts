/**
 * Open-ended judge powered by Gemini 2.5 Flash via `@ai-sdk/google` directly.
 *
 * Per the spec's resolved decisions:
 *   - Single judge model (no Zen routing).
 *   - Pinned prompt + version so historical results don't silently drift
 *     when we tweak the rubric template.
 *   - Strict pass/fail. The judge may emit nuanced reasoning, but the
 *     contract with the harness is a binary.
 */

import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import type { JudgeVerdict } from "./types";

/**
 * Bump this whenever the judge prompt or model changes. Stored alongside
 * each trial in the result store so historical trends remain comparable.
 */
export const LLM_JUDGE_VERSION = "v1.2026-05-22";

export const JUDGE_MODEL_ID = "gemini-3.5-flash";

const judgeSchema = z.object({
  passed: z
    .boolean()
    .describe("True if the agent's answer satisfies the rubric, false otherwise."),
  reasoning: z
    .string()
    .describe(
      "Short explanation (1-3 sentences) of the verdict — quote the agent's answer if it helps.",
    ),
});

const SYSTEM = `You are evaluating whether an autonomous browser agent successfully completed a task.

You will be given:
- The original instruction the agent received.
- A pass/fail rubric describing what counts as success.
- Optionally, a ground-truth expected answer.
- The agent's final answer.

Apply the rubric strictly. Do not give credit for partial work or "almost there" answers — autonomous browser tasks need binary outcomes. If the agent emitted no answer or an irrelevant answer, fail.

Output JSON: { "passed": boolean, "reasoning": string }`;

export interface LlmJudgeInput {
  instruction: string;
  rubric: string;
  expectedAnswer?: string;
  agentAnswer: string;
}

export async function llmJudge(input: LlmJudgeInput): Promise<JudgeVerdict> {
  const userPrompt = [
    `Original instruction:`,
    input.instruction,
    ``,
    `Rubric:`,
    input.rubric === "generic" 
      ? `Determine if the agent successfully completed the instruction based on its answer. If it claims it couldn't find the information, or if its answer is obviously incorrect/incomplete based on the instruction, fail it. Otherwise, pass it.`
      : input.rubric,
    input.expectedAnswer
      ? `\nExpected answer (ground truth):\n${input.expectedAnswer}`
      : ``,
    ``,
    `Agent's final answer:`,
    input.agentAnswer || "(no answer emitted)",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { object } = await generateObject({
      model: google(JUDGE_MODEL_ID),
      schema: judgeSchema,
      system: SYSTEM,
      prompt: userPrompt,
    });
    return {
      passed: object.passed,
      reasoning: object.reasoning,
      judgeVersion: LLM_JUDGE_VERSION,
      judgeModelId: JUDGE_MODEL_ID,
    };
  } catch (err) {
    return {
      passed: false,
      reasoning: `llm-judge call failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      judgeVersion: LLM_JUDGE_VERSION,
    };
  }
}
