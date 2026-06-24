import { describe, expect, it } from "vitest";
import { validateUIMessages, convertToModelMessages, tool } from "ai";
import { z } from "zod";
import {
  terminalizeApprovedToolCalls,
  type RawToolOutput,
} from "../compacting-transport";
import type { AgentUIMessage } from "@/lib/types";

/**
 * Regression test for the bug:
 *
 *   "tool_use ids were found without tool_result blocks immediately after"
 *
 * fired by Anthropic/Bedrock during a Plan-mode rejection-loop iteration.
 *
 * Scenario
 * --------
 * 1. Plan mode. The agent calls `proposePlan`. The SDK marks the tool
 *    part `approval-responded(approved: true, output: undefined)` after
 *    the user clicks Approve.
 * 2. Round 0 of the rejection loop runs. The SDK auto-resumes the
 *    approved call (it's the last message at this moment) and the tool
 *    runs, emitting `tool-output-available` chunks. Those chunks flow
 *    through the controller to the user but the rejection loop's
 *    LOCAL `messages` array is not mutated.
 * 3. Completion check rejects. A synthetic feedback user message is
 *    appended. Round 1 starts.
 * 4. Round 1's `convertToModelMessages` call sees the proposePlan part
 *    still in `approval-responded` state. The SDK's
 *    `collect-tool-approvals` only inspects `messages.at(-1)` (now the
 *    synthetic feedback), so it doesn't resume. The converter emits
 *    `tool_use` + `tool-approval-request` + `tool-approval-response`
 *    with NO `tool-result` block. Anthropic rejects.
 *
 * Fix
 * ---
 * Between rounds, `terminalizeApprovedToolCalls` walks `messages` and
 * mutates each approved-but-unfinished part to a terminal state using
 * the raw outputs `pipeAndObserve` collected from the iteration's
 * `tool-output-available` chunks (matched by `toolCallId`).
 *
 * Both halves of the test below assert the Anthropic pairing rule
 * directly: every `tool-call` in the resulting model messages must have
 * a matching `tool-result`.
 */

const proposePlanLikeTool = tool({
  description: "test proposePlan",
  inputSchema: z.object({
    goal: z.string(),
    sites: z.array(z.string()),
    todos: z.array(z.object({ content: z.string() })),
    allowNetwork: z.boolean(),
  }),
  outputSchema: z.object({
    approved: z.literal(true),
    plan: z.object({
      goal: z.string(),
      sites: z.array(z.string()),
      allowNetwork: z.boolean(),
      approvedAt: z.number(),
      extensions: z.array(z.unknown()),
    }),
  }),
  execute: async () => ({
    approved: true as const,
    plan: {
      goal: "g",
      sites: [],
      allowNetwork: false,
      approvedAt: 0,
      extensions: [],
    },
  }),
});

// SDK ToolSet expects Tool<unknown, unknown>; widen for the helper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tools = { proposePlan: proposePlanLikeTool } as any;

function userMsg(text: string, id: string): AgentUIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}

function strandedRoundOneMessages(): AgentUIMessage[] {
  // The exact shape the rejection loop hands to round 1 BEFORE the
  // fix is applied:
  //   user: "do X" → assistant: <approved proposePlan, no output yet>
  //                  → user: <synthetic completion-check feedback>
  return [
    userMsg("do X", "u-orig"),
    {
      id: "a-plan",
      role: "assistant",
      parts: [
        {
          type: "tool-proposePlan",
          toolCallId: "toolu_bdrk_001",
          state: "approval-responded",
          input: {
            goal: "demo",
            sites: ["https://example.com"],
            todos: [{ content: "step 1" }],
            allowNetwork: false,
          },
          approval: { id: "ap1", approved: true },
        },
      ],
    },
    userMsg("[completion-check feedback] missing item", "u-feedback"),
  ] as unknown as AgentUIMessage[];
}

describe("terminalizeApprovedToolCalls — Anthropic tool_use/tool_result pairing", () => {
  it("REPRODUCES the bug: a stranded approved approval-responded part produces a tool_use with no tool_result", async () => {
    const messages = strandedRoundOneMessages();

    const validated = await validateUIMessages({
      messages: messages as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of modelMessages) {
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

    // Bug shape: tool-call exists, paired tool-result does NOT.
    expect(toolUseIds.has("toolu_bdrk_001")).toBe(true);
    expect(toolResultIds.has("toolu_bdrk_001")).toBe(false);
  });

  it("FIX (completed): every tool_use has a paired tool_result after terminalize with a 'completed' raw output", async () => {
    const messages = strandedRoundOneMessages();
    const rawOutputs = new Map<string, RawToolOutput>([
      [
        "toolu_bdrk_001",
        {
          state: "completed",
          output: {
            approved: true,
            plan: {
              goal: "demo",
              sites: ["https://example.com"],
              allowNetwork: false,
              approvedAt: 1700000000000,
              extensions: [],
            },
          },
        },
      ],
    ]);

    const healed = terminalizeApprovedToolCalls(messages, rawOutputs);
    const validated = await validateUIMessages({
      messages: healed as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of modelMessages) {
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

    // Anthropic rule: every tool_use needs a tool_result.
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
    expect(toolUseIds.has("toolu_bdrk_001")).toBe(true);
    expect(toolResultIds.has("toolu_bdrk_001")).toBe(true);
  });

  it("FIX (errored): a tool that errored mid-resume is healed to output-error with the captured errorText", async () => {
    const messages = strandedRoundOneMessages();
    const rawOutputs = new Map<string, RawToolOutput>([
      [
        "toolu_bdrk_001",
        { state: "errored", errorText: "tool blew up" },
      ],
    ]);

    const healed = terminalizeApprovedToolCalls(messages, rawOutputs);
    // Locate the healed part and assert its terminal shape.
    const part = (healed[1].parts[0] ?? {}) as Record<string, unknown>;
    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe("tool blew up");
    expect(part.output).toBeUndefined();

    // And it round-trips through the converter without producing a
    // dangling tool_use.
    const validated = await validateUIMessages({
      messages: healed as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of modelMessages) {
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
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });

  it("FALLBACK: when no raw output is available, heals to output-error with the generic interruption text", async () => {
    const messages = strandedRoundOneMessages();
    // Empty map — we observed nothing for this toolCallId (e.g. the
    // chunk stream ended before any output/error chunk arrived).
    const rawOutputs = new Map<string, RawToolOutput>();

    const healed = terminalizeApprovedToolCalls(messages, rawOutputs);
    const part = (healed[1].parts[0] ?? {}) as Record<string, unknown>;
    expect(part.state).toBe("output-error");
    expect(typeof part.errorText).toBe("string");
    expect(part.errorText).toMatch(/interrupted/i);

    const validated = await validateUIMessages({
      messages: healed as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of modelMessages) {
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
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });

  it("does not mutate parts that are already terminal or that don't match the approved-no-output shape", () => {
    const messages: AgentUIMessage[] = [
      userMsg("go", "u1"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          // Already terminal: leave alone.
          {
            type: "tool-proposePlan",
            toolCallId: "id-1",
            state: "output-available",
            input: { goal: "g", sites: [], todos: [], allowNetwork: false },
            output: { approved: true, plan: {} },
          },
          // Denied via approval response: not in scope of this helper
          // (handled by repairToolPart's output-denied path).
          {
            type: "tool-proposePlan",
            toolCallId: "id-2",
            state: "approval-responded",
            input: { goal: "g", sites: [], todos: [], allowNetwork: false },
            approval: { id: "ap2", approved: false },
          },
          // Approved but already has an output (defensive — shouldn't
          // happen, but if it did we should NOT clobber it).
          {
            type: "tool-proposePlan",
            toolCallId: "id-3",
            state: "approval-responded",
            input: { goal: "g", sites: [], todos: [], allowNetwork: false },
            approval: { id: "ap3", approved: true },
            output: { approved: true, plan: { existing: "result" } },
          },
        ],
      } as unknown as AgentUIMessage,
    ];

    const healed = terminalizeApprovedToolCalls(
      messages,
      new Map<string, RawToolOutput>(),
    );

    // Same identity → same array reference (no mutation).
    expect(healed).toBe(messages);
  });

  it("preserves toolCallId and input when healing", () => {
    const messages = strandedRoundOneMessages();
    const rawOutputs = new Map<string, RawToolOutput>([
      [
        "toolu_bdrk_001",
        {
          state: "completed",
          output: { approved: true, plan: { goal: "demo" } },
        },
      ],
    ]);
    const healed = terminalizeApprovedToolCalls(messages, rawOutputs);
    const part = healed[1].parts[0] as Record<string, unknown>;
    expect(part.toolCallId).toBe("toolu_bdrk_001");
    expect(part.input).toEqual({
      goal: "demo",
      sites: ["https://example.com"],
      todos: [{ content: "step 1" }],
      allowNetwork: false,
    });
    expect(part.state).toBe("output-available");
    expect(part.output).toEqual({
      approved: true,
      plan: { goal: "demo" },
    });
  });
});
