import { describe, expect, it } from "vitest";
import { rewriteForLLM } from "../compacting-transport";
import type { AgentUIMessage } from "../../types";

// Helpers ────────────────────────────────────────────────────────────

function userMsg(text: string, id = `u-${Math.random()}`): AgentUIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as AgentUIMessage;
}

function assistantToolPart(
  state: string,
  extra: Record<string, unknown> = {},
  toolName = "navigate",
) {
  return {
    type: `tool-${toolName}` as const,
    toolCallId: `call-${state}`,
    state,
    input: { url: "https://example.com" },
    ...extra,
  } as unknown as AgentUIMessage["parts"][number];
}

function assistantWithPart(
  part: AgentUIMessage["parts"][number],
  id = `a-${Math.random()}`,
): AgentUIMessage {
  return {
    id,
    role: "assistant",
    parts: [part],
  } as AgentUIMessage;
}

// Tests ──────────────────────────────────────────────────────────────

describe("rewriteForLLM tool-state heal", () => {
  it("leaves terminal output-available parts untouched", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(
        assistantToolPart("output-available", {
          output: { navigated: true, url: "https://example.com" },
        }),
      ),
    ];
    const out = rewriteForLLM(msgs);
    expect(out).toHaveLength(2);
    const part = out[1].parts[0] as { state: string; output: unknown };
    expect(part.state).toBe("output-available");
    expect(part.output).toBeDefined();
  });

  it("leaves terminal output-error parts untouched", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(
        assistantToolPart("output-error", { errorText: "boom" }),
      ),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string; errorText: string };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toBe("boom");
  });

  it("leaves terminal output-denied parts untouched", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(
        assistantToolPart("output-denied", {
          approval: { id: "ap1", approved: false, reason: "user denied" },
        }),
      ),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string };
    expect(part.state).toBe("output-denied");
  });

  it("heals input-available parts to output-error", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(assistantToolPart("input-available")),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as {
      state: string;
      errorText?: string;
      output?: unknown;
    };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toMatch(/interrupted/i);
    expect(part.output).toBeUndefined();
  });

  it("heals input-streaming parts to output-error (the case that triggered the bug)", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(assistantToolPart("input-streaming")),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string; errorText?: string };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toMatch(/interrupted/i);
  });

  it("heals output-streaming parts to output-error", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(
        assistantToolPart("output-streaming", { output: { partial: 1 } }),
      ),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as {
      state: string;
      errorText?: string;
      output?: unknown;
    };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toMatch(/interrupted/i);
    // Partial output is dropped so the part shape is unambiguous —
    // errorText is the sole carrier of meaning for output-error.
    expect(part.output).toBeUndefined();
  });

  it("heals approval-requested parts to output-error", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(
        assistantToolPart("approval-requested", {
          approval: { id: "ap1" },
        }),
      ),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string };
    // The transport-level heal collapses every non-terminal state to
    // output-error. The chat-hook-level heal preserves approval
    // semantics (output-denied), but at the transport boundary we only
    // care about producing a valid model message; downgrading to
    // output-error is safer than a dedicated approval path here.
    expect(part.state).toBe("output-error");
  });

  it("heals an unrecognized future state defensively", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(assistantToolPart("totally-new-state")),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string };
    expect(part.state).toBe("output-error");
  });

  // ── approval-responded: the resume point (NOT a heal target) ──

  it("preserves an APPROVED approval-responded part so the SDK re-runs the tool (install_skill / MCP approval bug)", () => {
    // The exact "Interrupted on approval" bug: user clicked Allow, the
    // SDK marked the dynamic-tool part approval-responded(approved:true)
    // and fired the resume. convertToModelMessages re-executes from this
    // state via the tool-approval-response it emits — but ONLY if we
    // leave the part intact. Collapsing it to output-error here means
    // the tool never runs and the user sees "Interrupted".
    const part = {
      type: "dynamic-tool",
      toolCallId: "install-1",
      toolName: "install_skill",
      state: "approval-responded",
      input: { source: "sales-skills/sales/sales-attio" },
      approval: { id: "ap1", approved: true },
    } as unknown as AgentUIMessage["parts"][number];
    const msgs: AgentUIMessage[] = [
      userMsg("install sales-attio"),
      assistantWithPart(part),
    ];
    const out = rewriteForLLM(msgs);
    const healed = out[1].parts[0] as {
      state: string;
      approval: { id: string; approved: boolean };
      errorText?: string;
    };
    expect(healed.state).toBe("approval-responded");
    expect(healed.approval).toEqual({ id: "ap1", approved: true });
    expect(healed.errorText).toBeUndefined();
    // No mutation → same instance returned.
    expect(out[1]).toBe(msgs[1]);
  });

  it("folds a DENIED approval-responded part to output-denied (preserving reason)", () => {
    const part = {
      type: "tool-navigate",
      toolCallId: "denied-resp",
      state: "approval-responded",
      input: { url: "https://example.com" },
      approval: { id: "ap1", approved: false, reason: "nope" },
    } as unknown as AgentUIMessage["parts"][number];
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(part),
    ];
    const out = rewriteForLLM(msgs);
    const healed = out[1].parts[0] as {
      state: string;
      approval: { id: string; approved: boolean; reason?: string };
    };
    expect(healed.state).toBe("output-denied");
    expect(healed.approval).toEqual({
      id: "ap1",
      approved: false,
      reason: "nope",
    });
  });

  it("leaves missing input undefined on an approved approval-responded part (no {} synthesis)", () => {
    const part = {
      type: "dynamic-tool",
      toolCallId: "install-no-input",
      toolName: "install_skill",
      state: "approval-responded",
      approval: { id: "ap2", approved: true },
      // input deliberately missing
    } as unknown as AgentUIMessage["parts"][number];
    const msgs: AgentUIMessage[] = [
      userMsg("install"),
      assistantWithPart(part),
    ];
    const out = rewriteForLLM(msgs);
    const healed = out[1].parts[0] as { state: string; input: unknown };
    expect(healed.state).toBe("approval-responded");
    // Synthesizing {} here would make validateUIMessages run the tool's
    // (possibly strict) schema against an empty object and fail. Absent
    // input must stay absent.
    expect(healed.input).toBeUndefined();
  });

  it("heals an approval-responded part with malformed approval to output-error", () => {
    const part = {
      type: "tool-navigate",
      toolCallId: "resp-bad",
      state: "approval-responded",
      input: { url: "https://example.com" },
      approval: { id: undefined, approved: true },
    } as unknown as AgentUIMessage["parts"][number];
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(part),
    ];
    const out = rewriteForLLM(msgs);
    const healed = out[1].parts[0] as { state: string };
    expect(healed.state).toBe("output-error");
  });

  it("preserves non-tool parts (text, data-*) regardless of healing", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "thinking..." },
          assistantToolPart("input-streaming"),
          { type: "text", text: "more thinking" },
        ],
      } as AgentUIMessage,
    ];
    const out = rewriteForLLM(msgs);
    expect(out[1].parts).toHaveLength(3);
    expect((out[1].parts[0] as { type: string }).type).toBe("text");
    expect((out[1].parts[1] as { state: string }).state).toBe("output-error");
    expect((out[1].parts[2] as { type: string }).type).toBe("text");
  });

  it("returns the same message instance when no heal is needed (no extra renders)", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(
        assistantToolPart("output-available", { output: { ok: true } }),
      ),
    ];
    const out = rewriteForLLM(msgs);
    expect(out[1]).toBe(msgs[1]);
  });

  it("heals dynamic-tool parts the same as tool-* parts", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart({
        type: "dynamic-tool",
        toolCallId: "dt1",
        toolName: "mcpTool",
        state: "input-available",
        input: { foo: "bar" },
      } as unknown as AgentUIMessage["parts"][number]),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string; errorText?: string };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toMatch(/interrupted/i);
  });

  // ── Strict-shape repair: input/output/errorText must be present ──

  it("leaves missing input undefined on a non-terminal part (no {} synthesis)", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart({
        type: "tool-navigate",
        toolCallId: "no-input",
        state: "input-streaming",
        // input deliberately missing
      } as unknown as AgentUIMessage["parts"][number]),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string; input: unknown };
    expect(part.state).toBe("output-error");
    expect(part.input).toBeUndefined();
  });

  it("leaves missing input undefined on a terminal output-error part (no {} synthesis)", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart({
        type: "tool-navigate",
        toolCallId: "err-no-input",
        state: "output-error",
        errorText: "boom",
        // input missing — convertToModelMessages tolerates undefined input
        // on errored tool-calls, and validateUIMessages skips schema
        // validation when output-error input is undefined.
      } as unknown as AgentUIMessage["parts"][number]),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { input: unknown; errorText: string };
    expect(part.input).toBeUndefined();
    expect(part.errorText).toBe("boom");
  });

  it("downgrades output-available with missing output to output-error", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart({
        type: "tool-navigate",
        toolCallId: "av-no-output",
        state: "output-available",
        input: { url: "https://example.com" },
        // output missing
      } as unknown as AgentUIMessage["parts"][number]),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as {
      state: string;
      errorText: string;
      output?: unknown;
    };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toMatch(/interrupted/i);
    expect(part.output).toBeUndefined();
  });

  it("fills in missing errorText on output-error", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart({
        type: "tool-navigate",
        toolCallId: "err-no-text",
        state: "output-error",
        input: { url: "https://example.com" },
        // errorText missing
      } as unknown as AgentUIMessage["parts"][number]),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { errorText: string };
    expect(typeof part.errorText).toBe("string");
    expect(part.errorText.length).toBeGreaterThan(0);
  });

  it("downgrades output-denied with malformed approval to output-error", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart({
        type: "tool-navigate",
        toolCallId: "denied-no-approval",
        state: "output-denied",
        input: { url: "https://example.com" },
        // approval missing/malformed
      } as unknown as AgentUIMessage["parts"][number]),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string; errorText: string };
    expect(part.state).toBe("output-error");
    expect(part.errorText).toMatch(/interrupted/i);
  });

  it("downgrades output-denied with approved=true (contradictory) to output-error", () => {
    // Strict-shape contract: state=output-denied REQUIRES approved=false.
    // `approved: true` paired with that state is semantically nonsense
    // and gets healed to a clean output-error.
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart({
        type: "tool-navigate",
        toolCallId: "denied-but-approved",
        state: "output-denied",
        input: { url: "https://example.com" },
        approval: { id: "ap1", approved: true },
      } as unknown as AgentUIMessage["parts"][number]),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string; errorText: string };
    expect(part.state).toBe("output-error");
  });

  it("approval-requested with non-string id falls through to output-error heal", () => {
    // Defensive: malformed approval id (e.g. undefined or number)
    // shouldn't be carried forward into a synthesized output-denied —
    // we don't trust it. Heal to output-error instead.
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart({
        type: "tool-navigate",
        toolCallId: "approval-bad-id",
        state: "approval-requested",
        input: { url: "https://example.com" },
        approval: { id: undefined },
      } as unknown as AgentUIMessage["parts"][number]),
    ];
    const out = rewriteForLLM(msgs);
    const part = out[1].parts[0] as { state: string; errorText: string };
    expect(part.state).toBe("output-error");
  });

  it("preserves a fully well-formed output-available part as the same instance", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(
        assistantToolPart("output-available", {
          output: { type: "json", value: { ok: true } },
          input: { url: "https://example.com" },
        }),
      ),
    ];
    const out = rewriteForLLM(msgs);
    expect(out[1]).toBe(msgs[1]);
  });

  it("preserves a fully well-formed output-denied part as the same instance", () => {
    const msgs: AgentUIMessage[] = [
      userMsg("hi"),
      assistantWithPart(
        assistantToolPart("output-denied", {
          input: { url: "https://example.com" },
          approval: { id: "ap1", approved: false, reason: "user denied" },
        }),
      ),
    ];
    const out = rewriteForLLM(msgs);
    expect(out[1]).toBe(msgs[1]);
  });
});
