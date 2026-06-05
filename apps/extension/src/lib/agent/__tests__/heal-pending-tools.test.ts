import { describe, expect, it } from "vitest";
import { healPendingTools } from "../heal-pending-tools";
import type { AgentUIMessage } from "@/lib/types";

/**
 * Regression tests for the two errors that occurred when the agent ran
 * executePython while a failed MCP tool sat in history:
 *
 *  ERROR 1: "Type validation failed for messages[..].input (mcp_..., id: ...)
 *           Value: {} ... path: ['list']" — caused by healing a no-input
 *           tool call to output-error with input defaulted to `{}`, which
 *           validateUIMessages then ran against the MCP tool's strict schema.
 *
 *  ERROR 2: "tool_use ids were found without tool_result blocks" — caused by
 *           leaving an approved approval-responded call un-terminalized; once
 *           a user message follows it the SDK can't resume it, so
 *           convertToModelMessages emits a tool_use with no tool_result.
 */

function userMsg(text: string, id = `u-${Math.random()}`): AgentUIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] } as AgentUIMessage;
}

function assistantWithPart(
  part: AgentUIMessage["parts"][number],
  id = `a-${Math.random()}`,
): AgentUIMessage {
  return { id, role: "assistant", parts: [part] } as AgentUIMessage;
}

function firstPart(m: AgentUIMessage) {
  return m.parts[0] as Record<string, unknown>;
}

describe("healPendingTools — Error 1 (no {} input synthesis)", () => {
  it("heals a no-input interrupted MCP tool call to output-error WITHOUT adding input:{}", () => {
    const part = {
      type: "tool-mcp_srv_list-records-in-list",
      toolCallId: "toolu_1",
      state: "input-available",
      // input deliberately absent (args never finished streaming)
    } as unknown as AgentUIMessage["parts"][number];
    const msgs = [userMsg("go"), assistantWithPart(part)];

    const { healed, healedMessages } = healPendingTools(msgs, "superseded");
    expect(healedMessages).toHaveLength(1);
    const p = firstPart(healed[1]);
    expect(p.state).toBe("output-error");
    // The crux: input must NOT be {} (which would fail the MCP schema's
    // required `list` field in validateUIMessages). It must be the `undefined`
    // value with the key PRESENT (the structural UIMessage schema requires the
    // key; the per-tool schema check is skipped when the value is undefined).
    expect("input" in p).toBe(true);
    expect(p.input).toBeUndefined();
    expect(typeof p.errorText).toBe("string");
  });

  it("preserves a real input when one exists", () => {
    const part = {
      type: "tool-mcp_srv_list-records-in-list",
      toolCallId: "toolu_2",
      state: "input-available",
      input: { list: "abc" },
    } as unknown as AgentUIMessage["parts"][number];
    const msgs = [userMsg("go"), assistantWithPart(part)];

    const { healed } = healPendingTools(msgs, "superseded");
    const p = firstPart(healed[1]);
    expect(p.state).toBe("output-error");
    expect(p.input).toEqual({ list: "abc" });
  });

  it("leaves a well-formed output-error part (no input) untouched", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "mcp_srv_x",
      toolCallId: "toolu_3",
      state: "output-error",
      errorText: "boom",
    } as unknown as AgentUIMessage["parts"][number];
    const msgs = [userMsg("go"), assistantWithPart(part)];

    const { healedMessages } = healPendingTools(msgs, "superseded");
    // No heal needed → no change (missing input is fine on a terminal part).
    expect(healedMessages).toHaveLength(0);
  });
});

describe("healPendingTools — Error 2 (terminalize approved approval-responded)", () => {
  it("folds an approved, output-less approval-responded to output-error (so it gets a tool_result)", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "mcp_srv_write",
      toolCallId: "toolu_4",
      state: "approval-responded",
      input: { foo: "bar" },
      approval: { id: "ap1", approved: true },
    } as unknown as AgentUIMessage["parts"][number];
    const msgs = [userMsg("go"), assistantWithPart(part)];

    const { healed, healedMessages } = healPendingTools(msgs, "superseded");
    expect(healedMessages).toHaveLength(1);
    const p = firstPart(healed[1]);
    expect(p.state).toBe("output-error");
    expect(p.input).toEqual({ foo: "bar" });
    expect(typeof p.errorText).toBe("string");
  });

  it("still folds a DENIED approval-responded to output-denied", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "mcp_srv_write",
      toolCallId: "toolu_5",
      state: "approval-responded",
      input: { foo: "bar" },
      approval: { id: "ap1", approved: false, reason: "nope" },
    } as unknown as AgentUIMessage["parts"][number];
    const msgs = [userMsg("go"), assistantWithPart(part)];

    const { healed } = healPendingTools(msgs, "superseded");
    const p = firstPart(healed[1]);
    expect(p.state).toBe("output-denied");
    expect(p.approval).toEqual({ id: "ap1", approved: false, reason: "nope" });
  });

  it("folds an approved approval-responded with NO input to output-error WITHOUT input:{}", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "mcp_srv_write",
      toolCallId: "toolu_6",
      state: "approval-responded",
      approval: { id: "ap1", approved: true },
      // input absent
    } as unknown as AgentUIMessage["parts"][number];
    const msgs = [userMsg("go"), assistantWithPart(part)];

    const { healed } = healPendingTools(msgs, "superseded");
    const p = firstPart(healed[1]);
    expect(p.state).toBe("output-error");
    // Key present, value undefined (never {}).
    expect("input" in p).toBe(true);
    expect(p.input).toBeUndefined();
  });
});

describe("healPendingTools — unchanged behaviors", () => {
  it("folds approval-requested to output-denied", () => {
    const part = {
      type: "tool-navigate",
      toolCallId: "toolu_7",
      state: "approval-requested",
      input: { url: "https://x" },
      approval: { id: "ap1" },
    } as unknown as AgentUIMessage["parts"][number];
    const msgs = [userMsg("go"), assistantWithPart(part)];

    const { healed } = healPendingTools(msgs, "superseded by new user message");
    const p = firstPart(healed[1]);
    expect(p.state).toBe("output-denied");
    expect(p.approval).toEqual({
      id: "ap1",
      approved: false,
      reason: "superseded by new user message",
    });
  });

  it("returns the same list when nothing needs healing", () => {
    const part = {
      type: "tool-navigate",
      toolCallId: "toolu_8",
      state: "output-available",
      input: { url: "https://x" },
      output: { ok: true },
    } as unknown as AgentUIMessage["parts"][number];
    const msgs = [userMsg("go"), assistantWithPart(part)];

    const { healed, healedMessages } = healPendingTools(msgs, "x");
    expect(healedMessages).toHaveLength(0);
    expect(healed).toBe(msgs);
  });
});
