import { describe, expect, it } from "vitest";
import {
  validateUIMessages,
  convertToModelMessages,
  tool,
} from "ai";
import {
  rewriteForLLM,
  assertModelMessageToolInputs,
} from "../compacting-transport";
import { jsonSchemaToZod } from "@/lib/mcp/schema-to-zod";
import type { AgentUIMessage } from "@/lib/types";

/**
 * End-to-end regression for THE Opus bug:
 *
 *   Anthropic 400: messages.<i>.content.<j>.tool_use.input:
 *   Input should be a valid dictionary
 *
 * The exact failure mode: Opus calls a no-arg MCP tool (e.g. Attio's
 * `list-attribute-definitions`) and emits `input: ""` instead of
 * `input: {}`. The pre-fix loose schema accepted it, the persistence
 * layer wrote it, every subsequent send 400'd Anthropic. Gemini coerced
 * the same shape silently, so retrying on Gemini "just worked" — which
 * is the smoking-gun symptom this regression test guards against.
 *
 * The full pipeline this test exercises:
 *   1. MCP tool surface comes from `jsonSchemaToZod` over a real-world
 *      Attio-style schema.
 *   2. A persisted UIMessage carrying `input: ""` (the actual bug shape)
 *      is run through `rewriteForLLM`.
 *   3. The result is `validateUIMessages`-checked against the tools.
 *   4. Converted via `convertToModelMessages`.
 *   5. The final `ModelMessage[]` is asserted to contain ONLY object
 *      `tool_use.input` values via `assertModelMessageToolInputs` — the
 *      shape Anthropic accepts.
 *
 * If any layer regresses, this test fails the way the production bug
 * presented (validation throw or non-object input on the wire).
 */

const ATTIO_LIST_ATTR_DEFS_SCHEMA = {
  type: "object",
  properties: {
    object: { type: "string", description: "Object whose attributes to list" },
    query: { type: "string" },
    offset: { type: "number" },
    limit: { type: "number" },
  },
};

const ATTIO_LIST_RECORDS_SCHEMA = {
  type: "object",
  properties: {
    list: { type: "string" },
    filter: { type: "object" },
    limit: { type: "number" },
  },
  required: ["list"],
};

function buildMcpTools() {
  // Mirrors what mcp/registry.ts does at runtime: jsonSchemaToZod over
  // each MCP tool's inputSchema, then wrap with `tool()`. The SDK's tool
  // map expects Tool<unknown, unknown>; tool() narrows the output type
  // from `execute`'s return, so we widen via `as any` for these helper
  // calls (matches the pattern in heal-validate-integration.test.ts).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    "mcp_attio_list-attribute-definitions": tool({
      description: "Attio: list attribute definitions",
      inputSchema: jsonSchemaToZod(ATTIO_LIST_ATTR_DEFS_SCHEMA),
      execute: async () => "ok",
    }),
    "mcp_attio_list-records-in-list": tool({
      description: "Attio: list records in a list",
      inputSchema: jsonSchemaToZod(ATTIO_LIST_RECORDS_SCHEMA),
      execute: async () => "ok",
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function userMsg(text: string): AgentUIMessage {
  return {
    id: `u-${Math.random()}`,
    role: "user",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}

describe("Opus bug regression — full pipeline", () => {
  it("a no-arg MCP tool call with input:'' is RESCUED to {} and lands cleanly on the wire", async () => {
    // The exact production sequence that broke on Opus: the user asks the
    // agent to do something Attio-related, the model emits a tool_use with
    // input:"" for the no-required-args tool, and the next send 400s.
    const tools = buildMcpTools();
    const conversation: AgentUIMessage[] = [
      userMsg("list attio attribute definitions for People"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Looking up the list..." },
          {
            // Opus emits this shape for a no-arg call. Pre-fix:
            // jsonSchemaToZod returned an over-loose schema that accepted
            // "" and the persistence layer wrote it verbatim.
            type: "tool-mcp_attio_list-attribute-definitions",
            toolCallId: "toolu_no_arg",
            state: "output-error",
            errorText: "interrupted",
            input: "",
          },
        ],
      } as unknown as AgentUIMessage,
      userMsg("retry"),
    ];

    // Step 1: rewriteForLLM with tools threaded in (rule-5 rescue path).
    const rewritten = rewriteForLLM(conversation, tools);

    // Step 2: validate against tools. With the tightened schema this
    // now structurally enforces object inputs — but the rescue happened
    // upstream so input is already {}.
    const validated = await validateUIMessages({
      messages: rewritten as never,
      tools,
    });

    // Step 3: convert to ModelMessage[].
    const modelMessages = await convertToModelMessages(validated, { tools });

    // Step 4: last-mile assertion. Should be a no-op (everything is already
    // an object), but proves the contract.
    assertModelMessageToolInputs(modelMessages, "regression-test");

    // Final check: every tool-call on the wire has an OBJECT input.
    let toolCallsSeen = 0;
    for (const m of modelMessages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type: string; input?: unknown }>) {
        if (c.type === "tool-call") {
          toolCallsSeen++;
          expect(typeof c.input).toBe("object");
          expect(c.input).not.toBeNull();
          expect(Array.isArray(c.input)).toBe(false);
        }
      }
    }
    expect(toolCallsSeen).toBeGreaterThan(0);
  });

  it("a required-args MCP tool call with input:'' is DROPPED (no rescue available)", async () => {
    // For tools with required fields, "" cannot be coerced to {} (would
    // fail required-fields validation). The transport drops the part
    // instead of producing a malformed tool_use.
    const tools = buildMcpTools();
    const conversation: AgentUIMessage[] = [
      userMsg("list records in the People list"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Looking up the list..." },
          {
            type: "tool-mcp_attio_list-records-in-list",
            toolCallId: "toolu_required",
            state: "output-error",
            errorText: "interrupted",
            input: "",
          },
        ],
      } as unknown as AgentUIMessage,
      userMsg("retry"),
    ];

    const rewritten = rewriteForLLM(conversation, tools);
    const validated = await validateUIMessages({
      messages: rewritten as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });
    assertModelMessageToolInputs(modelMessages, "regression-test");

    // The dropped tool call shouldn't appear on the wire.
    const toolCalls: Array<{ toolCallId?: string }> = [];
    for (const m of modelMessages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{
        type: string;
        toolCallId?: string;
      }>) {
        if (c.type === "tool-call") toolCalls.push(c);
      }
    }
    expect(
      toolCalls.some((tc) => tc.toolCallId === "toolu_required"),
    ).toBe(false);
  });

  it("a mix of valid and bad tool calls produces a fully-clean wire payload", async () => {
    const tools = buildMcpTools();
    const conversation: AgentUIMessage[] = [
      userMsg("do a few things"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "step 1" },
          {
            type: "tool-mcp_attio_list-attribute-definitions",
            toolCallId: "toolu_good",
            state: "output-available",
            input: { object: "people" },
            output: { ok: true },
          },
          {
            type: "tool-mcp_attio_list-attribute-definitions",
            toolCallId: "toolu_opus_bug",
            state: "output-error",
            errorText: "interrupted",
            input: "", // ← Opus emission, rescuable to {}
          },
          {
            type: "tool-mcp_attio_list-records-in-list",
            toolCallId: "toolu_required_bad",
            state: "output-error",
            errorText: "interrupted",
            input: null, // ← non-rescuable, dropped
          },
        ],
      } as unknown as AgentUIMessage,
      userMsg("continue"),
    ];

    const rewritten = rewriteForLLM(conversation, tools);
    const validated = await validateUIMessages({
      messages: rewritten as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });
    assertModelMessageToolInputs(modelMessages, "regression-test");

    // Every tool-call on the wire is an object.
    const wireToolCalls: Array<{ toolCallId: string; input: unknown }> = [];
    for (const m of modelMessages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{
        type: string;
        toolCallId?: string;
        input?: unknown;
      }>) {
        if (c.type === "tool-call" && typeof c.toolCallId === "string") {
          wireToolCalls.push({ toolCallId: c.toolCallId, input: c.input });
        }
      }
    }

    // toolu_good: object input preserved.
    const good = wireToolCalls.find((tc) => tc.toolCallId === "toolu_good");
    expect(good?.input).toEqual({ object: "people" });

    // toolu_opus_bug: rescued to {} via rule 5.
    const opus = wireToolCalls.find((tc) => tc.toolCallId === "toolu_opus_bug");
    expect(opus?.input).toEqual({});

    // toolu_required_bad: dropped — must not appear on the wire.
    const bad = wireToolCalls.find(
      (tc) => tc.toolCallId === "toolu_required_bad",
    );
    expect(bad).toBeUndefined();

    // Sanity: every tool-call's input is an object.
    for (const tc of wireToolCalls) {
      expect(typeof tc.input).toBe("object");
      expect(tc.input).not.toBeNull();
      expect(Array.isArray(tc.input)).toBe(false);
    }
  });

  it("does not regress: a tool whose input has unexpected fields (server schema drift) passes through", async () => {
    // The tightened schema uses passthrough() at the property level so
    // an MCP server adding a new optional field between releases doesn't
    // cause client-side validation to strip the model's input. This
    // matters because a stripped field on the wire would silently
    // change tool semantics.
    const tools = {
      "mcp_some_tool": tool({
        description: "tool",
        inputSchema: jsonSchemaToZod({
          type: "object",
          properties: { known: { type: "string" } },
          required: ["known"],
        }),
        execute: async () => "ok",
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const conversation: AgentUIMessage[] = [
      userMsg("call it"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-mcp_some_tool",
            toolCallId: "toolu_drift",
            state: "output-available",
            input: { known: "x", new_optional: "kept" },
            output: { ok: true },
          },
        ],
      } as unknown as AgentUIMessage,
    ];

    const rewritten = rewriteForLLM(conversation, tools);
    const validated = await validateUIMessages({
      messages: rewritten as never,
      tools,
    });
    const modelMessages = await convertToModelMessages(validated, { tools });

    let inputOnWire: unknown;
    for (const m of modelMessages) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content as Array<{ type: string; input?: unknown }>) {
        if (c.type === "tool-call") inputOnWire = c.input;
      }
    }
    expect(inputOnWire).toMatchObject({ known: "x", new_optional: "kept" });
  });

  it("uses a non-strict object schema by default (validateUIMessages doesn't strip extras)", () => {
    // Direct schema check (independent of the full pipeline): the schema
    // converter's default is passthrough, not strict.
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { known: { type: "string" } },
    });
    const result = schema.safeParse({ known: "x", extra: "kept" });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.known).toBe("x");
      expect(data.extra).toBe("kept");
    }
  });

  it("explicit additionalProperties:false IS enforced when the server opts in", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { known: { type: "string" } },
      additionalProperties: false,
    });
    expect(schema.safeParse({ known: "x" }).success).toBe(true);
    expect(schema.safeParse({ known: "x", extra: "rejected" }).success).toBe(
      false,
    );
  });
});
