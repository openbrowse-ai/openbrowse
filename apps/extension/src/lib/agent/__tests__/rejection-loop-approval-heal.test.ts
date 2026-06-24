import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel, UIMessageChunk } from "ai";
import {
  runWithRejectionLoop,
  type RejectionLoopAgent,
} from "../compacting-transport";
import { completionCheckTelemetry } from "../completion-check/telemetry";
import { chatDb } from "../../chat-db";
import { setCurrentAgentModel } from "../current-agent-model";
import type { AgentUIMessage } from "../../types";

/**
 * Integration regression test for the bug reproduced in
 * `terminalize-approved-tool-calls.test.ts`, but exercised through the
 * full `runWithRejectionLoop` driver:
 *
 *   - Starting messages contain an approved-but-unfinished `proposePlan`
 *     tool part (state `approval-responded`, no output).
 *   - Round 0 streams `tool-output-available` chunks for that
 *     toolCallId (mimicking the SDK's auto-resume executing the tool).
 *   - Completion-check rejects.
 *   - Round 1 must observe a HEALED messages array — the proposePlan
 *     part terminalized to `output-available` using the raw output
 *     from round 0's chunks. Concretely, every `tool-call` in the
 *     round 1 prompt must have a paired `tool-result`.
 *
 * Without the fix, round 1's prompt has a dangling `tool-call` with no
 * `tool-result` — the exact shape Anthropic/Bedrock rejects with
 * "tool_use ids were found without tool_result blocks immediately after".
 */

function mockEvaluatorModel(verdictJson: object): LanguageModel {
  const m = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async () => ({
      content: [{ type: "text", text: JSON.stringify(verdictJson) }],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      warnings: [],
    })) as never,
  });
  return m as unknown as LanguageModel;
}

function rejectThenApproveModel(): LanguageModel {
  let call = 0;
  return new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async () => {
      const verdict =
        call === 0
          ? {
              decision: "reject",
              concerns: [
                {
                  dimension: "completeness",
                  detail: "needs more",
                  userSummary: "Needs more.",
                },
              ],
              reasoning: "incomplete",
              confidence: 0.8,
            }
          : {
              decision: "approve",
              concerns: [],
              reasoning: "fixed",
              confidence: 0.9,
            };
      call++;
      return {
        content: [{ type: "text", text: JSON.stringify(verdict) }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        warnings: [],
      };
    }) as never,
  }) as unknown as LanguageModel;
}

function userMessage(text: string, id = `u-${crypto.randomUUID()}`): AgentUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as AgentUIMessage;
}

/**
 * The starting messages a rejection-loop driver sees when the SDK's
 * auto-resume is about to run an approved proposePlan. The
 * `approval-responded` part has no `output` yet — the SDK fills it via
 * `collect-tool-approvals` during round 0.
 */
function startingMessagesWithApprovedProposePlan(): AgentUIMessage[] {
  return [
    userMessage("research keyboards", "u-orig"),
    {
      id: "a-plan",
      role: "assistant",
      parts: [
        {
          type: "tool-proposePlan",
          toolCallId: "toolu_bdrk_001",
          state: "approval-responded",
          input: {
            goal: "research mechanical keyboards",
            sites: ["https://example.com"],
            todos: [{ content: "search top 3" }],
            allowNetwork: false,
          },
          approval: { id: "ap1", approved: true },
        },
      ],
    },
  ] as unknown as AgentUIMessage[];
}

/**
 * Stub agent that emits, on round 0, the chunks the SDK's auto-resume
 * would produce when executing the approved proposePlan
 * (`tool-output-available` with the real output) followed by a final
 * markdown answer. Round 1 (post-rejection) emits only a follow-up
 * answer. Captures every prompt for assertions.
 */
function makeProposePlanResumeAgent(): RejectionLoopAgent & {
  promptHistory: Array<Awaited<ReturnType<RejectionLoopAgent["stream"]>>["toUIMessageStream"] extends never ? never : unknown>;
  callCount: number;
} {
  let i = 0;
  const promptHistory: unknown[] = [];
  return {
    tools: {},
    promptHistory: promptHistory as never,
    get callCount() {
      return i;
    },
    stream: async ({ prompt }) => {
      promptHistory.push(prompt);
      const round = i;
      i++;
      const id = `m-${i}`;
      let chunks: UIMessageChunk[];
      if (round === 0) {
        // Round 0: emit the resumed tool's output, then a draft.
        chunks = [
          // The SDK's auto-resume produces a `tool-output-available`
          // chunk with the real output. (No input chunk needed — the
          // input was already in the messages.)
          {
            type: "tool-output-available",
            toolCallId: "toolu_bdrk_001",
            output: {
              approved: true,
              plan: {
                goal: "research mechanical keyboards",
                sites: ["https://example.com"],
                allowNetwork: false,
                approvedAt: 1700000000000,
                extensions: [],
              },
            },
          } as never,
          { type: "text-start", id } as never,
          {
            type: "text-delta",
            id,
            delta: "Here is a draft answer that needs more.",
          } as never,
          { type: "text-end", id } as never,
        ];
      } else {
        // Round 1: a corrected answer.
        chunks = [
          { type: "text-start", id } as never,
          { type: "text-delta", id, delta: "Improved second answer." } as never,
          { type: "text-end", id } as never,
        ];
      }
      return {
        toUIMessageStream: () =>
          new ReadableStream<UIMessageChunk>({
            start(controller) {
              for (const c of chunks) controller.enqueue(c);
              controller.close();
            },
          }),
      };
    },
  };
}

async function drainStream(
  s: ReadableStream<UIMessageChunk>,
): Promise<UIMessageChunk[]> {
  const reader = s.getReader();
  const out: UIMessageChunk[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("rejection loop heals approved approval-responded between rounds", () => {
  beforeEach(async () => {
    await completionCheckTelemetry._resetForTests();
    chatDb._resetForTests();
    setCurrentAgentModel(null);
  });

  afterEach(async () => {
    await completionCheckTelemetry._resetForTests();
  });

  it("round 1 prompt has a tool-call paired with a tool-result for the approved proposePlan", async () => {
    const agent = makeProposePlanResumeAgent();
    const evalModel = rejectThenApproveModel();

    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: startingMessagesWithApprovedProposePlan(),
      sendMessagesAtCall: startingMessagesWithApprovedProposePlan(),
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c-rl-heal",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "research keyboards",
        draftedResponse: "(filled by loop)",
        todos: [],
        // Include a tool call so the gate's trigger heuristic fires.
        toolCallTrace: [
          {
            name: "proposePlan",
            inputSummary: "{}",
            outputSummary: '{"approved":true}',
            state: "completed",
          },
        ],
        evaluatorModel: evalModel,
      }),
    });
    await drainStream(stream);

    // Two iterations expected: round 0 (rejected) + round 1 (approved).
    expect(agent.callCount).toBe(2);

    // Round 1's prompt is the second entry in promptHistory.
    const round1Prompt = agent.promptHistory[1] as Array<{
      role: string;
      content: unknown;
    }>;
    expect(Array.isArray(round1Prompt)).toBe(true);

    // Anthropic pairing rule: every tool-call has a tool-result.
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of round1Prompt) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{
        type: string;
        toolCallId?: string;
      }>) {
        if (c.type === "tool-call" && c.toolCallId)
          toolUseIds.add(c.toolCallId);
        if (c.type === "tool-result" && c.toolCallId)
          toolResultIds.add(c.toolCallId);
      }
    }
    expect(toolUseIds.has("toolu_bdrk_001")).toBe(true);
    expect(toolResultIds.has("toolu_bdrk_001")).toBe(true);
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });
});
