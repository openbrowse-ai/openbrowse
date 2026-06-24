import { describe, expect, it } from "vitest";
import { findPendingPlanApproval } from "../find-pending-plan-approval";
import type { AgentUIMessage } from "@/lib/agent/message-types";

/**
 * Helper to construct a minimal AgentUIMessage for tests. The hook /
 * SDK shape is wider than what the helper inspects, so we cast through
 * `unknown` to keep the test setup readable.
 */
function msg(
  role: "user" | "assistant" | "system",
  parts: Array<Record<string, unknown>>,
): AgentUIMessage {
  return { id: `m-${Math.random().toString(36).slice(2, 8)}`, role, parts } as unknown as AgentUIMessage;
}

describe("findPendingPlanApproval", () => {
  it("returns null on empty messages", () => {
    expect(findPendingPlanApproval([])).toBeNull();
  });

  it("returns null when no proposePlan part is in approval-requested", () => {
    const messages = [
      msg("user", [{ type: "text", text: "hi" }]),
      msg("assistant", [{ type: "text", text: "hello" }]),
    ];
    expect(findPendingPlanApproval(messages)).toBeNull();
  });

  it("returns the pending approval for a dynamic-tool-shaped proposePlan call", () => {
    const messages = [
      msg("user", [{ type: "text", text: "do thing" }]),
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-1",
          input: { goal: "test", sites: ["https://x.com"], todos: [], allowNetwork: false },
          approval: { id: "ap-1" },
        },
      ]),
    ];
    const out = findPendingPlanApproval(messages);
    expect(out).not.toBeNull();
    expect(out?.toolCallId).toBe("call-1");
    expect(out?.approvalId).toBe("ap-1");
    expect(out?.input).toEqual({
      goal: "test",
      sites: ["https://x.com"],
      todos: [],
      allowNetwork: false,
    });
  });

  it("returns the pending approval for a tool-proposePlan-shaped part", () => {
    // Some SDK versions surface tool parts as `tool-<name>` instead of
    // `dynamic-tool`. The helper recognizes both shapes.
    const messages = [
      msg("assistant", [
        {
          type: "tool-proposePlan",
          state: "approval-requested",
          toolCallId: "call-2",
          input: { goal: "g", sites: [], todos: [], allowNetwork: false },
          approval: { id: "ap-2" },
        },
      ]),
    ];
    const out = findPendingPlanApproval(messages);
    expect(out?.toolCallId).toBe("call-2");
    expect(out?.approvalId).toBe("ap-2");
  });

  it("ignores non-proposePlan tools in approval-requested", () => {
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "executeOnPage",
          state: "approval-requested",
          toolCallId: "call-x",
          input: { code: "..." },
          approval: { id: "ap-x" },
        },
      ]),
    ];
    expect(findPendingPlanApproval(messages)).toBeNull();
  });

  it("ignores proposePlan that has already advanced past approval-requested", () => {
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "output-available",
          toolCallId: "call-1",
          input: { goal: "g" },
          output: { approved: true, plan: { goal: "g", sites: [], allowNetwork: false, approvedAt: 0, extensions: [] } },
        },
      ]),
    ];
    expect(findPendingPlanApproval(messages)).toBeNull();
  });

  it("ignores user-role messages even with matching shape", () => {
    // Defensive: user-role messages can't carry tool-call parts in
    // production, but the helper guards on role explicitly.
    const messages = [
      msg("user", [
        {
          type: "tool-proposePlan",
          state: "approval-requested",
          toolCallId: "call-1",
          input: {},
          approval: { id: "ap-1" },
        },
      ]),
    ];
    expect(findPendingPlanApproval(messages)).toBeNull();
  });

  it("returns the LATEST pending approval when multiple exist (newest assistant message wins)", () => {
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-old",
          input: { goal: "old plan" },
          approval: { id: "ap-old" },
        },
      ]),
      msg("user", [{ type: "text", text: "make changes" }]),
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-new",
          input: { goal: "new plan" },
          approval: { id: "ap-new" },
        },
      ]),
    ];
    const out = findPendingPlanApproval(messages);
    expect(out?.toolCallId).toBe("call-new");
    expect(out?.input.goal).toBe("new plan");
  });

  it("returns null when the newest assistant message has no pending approval, even if an older one does", () => {
    // Mirrors the SDK's `messages.at(-1)`-based approval flow: only the
    // newest assistant message is actionable. A stale older
    // `approval-requested` part should never reach the composer (it
    // will be terminalized by healPendingTools at the next
    // edit/retry/regenerate boundary).
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-stale",
          input: { goal: "stale plan" },
          approval: { id: "ap-stale" },
        },
      ]),
      msg("user", [{ type: "text", text: "ignore that, do something else" }]),
      msg("assistant", [{ type: "text", text: "Sure, doing something else." }]),
    ];
    expect(findPendingPlanApproval(messages)).toBeNull();
  });

  it("returns null when proposePlan part lacks toolCallId or approval.id (defensive)", () => {
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          // No toolCallId
          input: {},
          approval: { id: "ap-1" },
        },
      ]),
    ];
    expect(findPendingPlanApproval(messages)).toBeNull();

    const messages2 = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-1",
          input: {},
          // No approval.id
          approval: {},
        },
      ]),
    ];
    expect(findPendingPlanApproval(messages2)).toBeNull();
  });

  it("returns input as empty object when input is undefined (streaming-incomplete safe)", () => {
    // The card defends against partial input internally; the helper just
    // normalizes undefined to {} so the consumer always gets an object.
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-1",
          // input: undefined,
          approval: { id: "ap-1" },
        },
      ]),
    ];
    const out = findPendingPlanApproval(messages);
    expect(out?.input).toEqual({});
  });

  it("returns input as empty object when input is null", () => {
    // `null` is `typeof "object"` but isn't a usable record; the helper
    // must normalize it to {} so consumers reading `.sites` / `.todos`
    // / etc. don't throw on undefined property access.
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-1",
          input: null,
          approval: { id: "ap-1" },
        },
      ]),
    ];
    const out = findPendingPlanApproval(messages);
    expect(out?.input).toEqual({});
  });

  it("returns input as empty object when input is an array", () => {
    // Arrays are `typeof "object"` but the consumer expects a record;
    // an array would `.map`-mistake `sites = ["x"][0]` etc. Guard.
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-1",
          input: ["bogus"],
          approval: { id: "ap-1" },
        },
      ]),
    ];
    const out = findPendingPlanApproval(messages);
    expect(out?.input).toEqual({});
  });

  it("returns input as empty object when input is a primitive", () => {
    const messages = [
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "proposePlan",
          state: "approval-requested",
          toolCallId: "call-1",
          input: "not an object",
          approval: { id: "ap-1" },
        },
      ]),
    ];
    const out = findPendingPlanApproval(messages);
    expect(out?.input).toEqual({});
  });
});
