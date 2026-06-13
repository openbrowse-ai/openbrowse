import { describe, expect, it } from "vitest";
import { validateUIMessages, convertToModelMessages, tool } from "ai";
import { healPendingTools } from "../heal-pending-tools";
import { rewriteForLLM } from "../compacting-transport";
import { jsonSchemaToZod } from "@/lib/mcp/schema-to-zod";
import type { AgentUIMessage } from "@/lib/types";

/**
 * End-to-end guard for ERROR 1 against the REAL SDK `validateUIMessages` and a
 * strict (MCP-like) tool schema. Proves:
 *   1. `{}` input on an output-error part fails validation (the bug).
 *   2. The heal output (input absent) passes validation (the fix).
 */

// Mirrors an Attio MCP tool: requires a `list` string.
const listTool = tool({
  description: "list records",
  inputSchema: jsonSchemaToZod({
    type: "object",
    properties: { list: { type: "string" } },
    required: ["list"],
  }),
  execute: async () => "ok",
});

// The SDK's tool map expects Tool<unknown, unknown>; tool() narrows the
// output type from `execute`'s return, so we widen for these helper calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tools = { "mcp_srv_list-records-in-list": listTool } as any;

function userMsg(text: string): AgentUIMessage {
  return { id: "u1", role: "user", parts: [{ type: "text", text }] } as AgentUIMessage;
}

describe("validateUIMessages + heal (Error 1 end-to-end)", () => {
  it("REPRODUCES the bug: an output-error MCP part with input:{} fails validation", async () => {
    const messages = [
      userMsg("go"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-mcp_srv_list-records-in-list",
            toolCallId: "toolu_1",
            state: "output-error",
            errorText: "interrupted",
            input: {}, // the offending default
          },
        ],
      },
    ] as unknown as AgentUIMessage[];

    await expect(
      validateUIMessages({ messages: messages as never, tools }),
    ).rejects.toThrow();
  });

  it("FIX: the healed part (input absent) passes validation", async () => {
    const stranded = [
      userMsg("go"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-mcp_srv_list-records-in-list",
            toolCallId: "toolu_1",
            state: "input-available",
            // no input — args never finished streaming
          },
        ],
      },
    ] as unknown as AgentUIMessage[];

    const { healed } = healPendingTools(stranded, "superseded");
    // Healed to output-error with NO input → SDK skips schema validation.
    await expect(
      validateUIMessages({ messages: healed as never, tools }),
    ).resolves.toBeDefined();
  });
});

describe("convertToModelMessages + heal (Error 2 end-to-end)", () => {
  it("every tool_use has a paired tool_result after healing an approved approval-responded", async () => {
    // Pre-heal: an approved approval-responded MCP call the SDK can no longer
    // resume (a user message will follow). Without the heal, this produces a
    // tool_use with no tool_result → Anthropic 400.
    const stranded = [
      userMsg("go"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-mcp_srv_list-records-in-list",
            toolCallId: "toolu_9",
            state: "approval-responded",
            input: { list: "abc" },
            approval: { id: "ap1", approved: true },
          },
        ],
      },
      userMsg("continue"),
    ] as unknown as AgentUIMessage[];

    const { healed } = healPendingTools(stranded, "superseded");
    const validated = await validateUIMessages({
      messages: healed as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });

    // Collect every tool-call id and every tool-result id across the prompt.
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of modelMessages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type: string; toolCallId?: string }>) {
        if (c.type === "tool-call" && c.toolCallId) toolUseIds.add(c.toolCallId);
        if (c.type === "tool-result" && c.toolCallId)
          toolResultIds.add(c.toolCallId);
      }
    }
    // Every tool_use must have a matching tool_result (the Anthropic rule).
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
    expect(toolUseIds.has("toolu_9")).toBe(true);
  });
});

describe("rewriteForLLM + convertToModelMessages (input-less interrupted call)", () => {
  it("produces NO tool-call with missing input (provider tool_use.input rejection)", async () => {
    // The production bug: an interrupted MCP call that never received its
    // input. Pre-fix this folded to output-error with input: undefined, and
    // convertToModelMessages emitted a tool-call with no input field →
    // Anthropic/Bedrock `tool_use.input: Field required` / Gemini silent
    // malformed-call error.
    const stranded = [
      userMsg("go"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "let me look that up" },
          {
            type: "tool-mcp_srv_list-records-in-list",
            toolCallId: "toolu_lost",
            state: "input-streaming",
            // no input — args never finished streaming
          },
        ],
      },
    ] as unknown as AgentUIMessage[];

    const rewritten = rewriteForLLM(stranded as never);
    const validated = await validateUIMessages({
      messages: rewritten as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });

    // No tool-call content may have an undefined/missing input.
    for (const m of modelMessages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type: string; input?: unknown }>) {
        if (c.type === "tool-call") {
          expect(c.input).toBeDefined();
        }
      }
    }

    // The interrupted tool part was dropped entirely; its surrounding text
    // survives.
    const allParts = rewritten.flatMap((m) => m.parts);
    expect(
      allParts.some(
        (p) =>
          (p as { toolCallId?: string }).toolCallId === "toolu_lost",
      ),
    ).toBe(false);
    expect(
      allParts.some((p) => p.type === "text" && p.text === "let me look that up"),
    ).toBe(true);
  });

  it("produces NO tool-call with missing input for a terminal output-error MCP part (Opus/Anthropic repro)", async () => {
    // The remaining Opus failure: a FAILED MCP tool call ("Updated list entry
    // — Failed") whose input was never captured, persisted as a terminal
    // output-error with no input. Pre-fix, convertToModelMessages emitted a
    // tool-call with input: undefined → Anthropic `tool_use.input: Field
    // required` (Gemini coerced it, so it only broke on Opus).
    const stranded = [
      userMsg("update the list"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "updating the list entry" },
          {
            type: "tool-mcp_srv_list-records-in-list",
            toolCallId: "toolu_failed",
            state: "output-error",
            errorText: "Updated list entry failed",
            // no input, no rawInput — input was never captured
          },
        ],
      },
      userMsg("try again"),
    ] as unknown as AgentUIMessage[];

    const rewritten = rewriteForLLM(stranded as never);
    const validated = await validateUIMessages({
      messages: rewritten as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });

    for (const m of modelMessages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type: string; input?: unknown }>) {
        if (c.type === "tool-call") {
          expect(c.input).toBeDefined();
        }
      }
    }

    // The input-less errored tool part was dropped; surrounding text survives.
    const allParts = rewritten.flatMap((m) => m.parts);
    expect(
      allParts.some(
        (p) => (p as { toolCallId?: string }).toolCallId === "toolu_failed",
      ),
    ).toBe(false);
    expect(
      allParts.some(
        (p) => p.type === "text" && p.text === "updating the list entry",
      ),
    ).toBe(true);
  });
});
