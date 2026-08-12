import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { shouldAutoResume } from "../should-auto-resume";

function msg(
  role: "user" | "assistant",
  parts: Array<Record<string, unknown>>,
): UIMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts,
  } as unknown as UIMessage;
}

const ANSWER = { outcome: "answered" as const, answers: [] };

function askUser(overrides: Record<string, unknown> = {}) {
  return {
    type: "dynamic-tool",
    toolName: "askUser",
    toolCallId: "call-ask",
    state: "output-available",
    input: { questions: [] },
    output: ANSWER,
    ...overrides,
  };
}

describe("shouldAutoResume — askUser", () => {
  it("resumes after an askUser call is answered", () => {
    expect(
      shouldAutoResume({
        messages: [msg("assistant", [{ type: "step-start" }, askUser()])],
      }),
    ).toBe(true);
  });

  it("resumes for a tool-askUser-shaped part too", () => {
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            askUser({ type: "tool-askUser", toolName: undefined }),
          ]),
        ],
      }),
    ).toBe(true);
  });

  it("resumes when the answer errored (output-error)", () => {
    // A failed write still needs the loop to continue — otherwise the
    // conversation is stuck with a tool_use and no tool_result.
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            askUser({
              state: "output-error",
              output: undefined,
              errorText: "boom",
            }),
          ]),
        ],
      }),
    ).toBe(true);
  });

  it("does NOT resume while the question is still unanswered", () => {
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            askUser({ state: "input-available", output: undefined }),
          ]),
        ],
      }),
    ).toBe(false);
  });

  it("does NOT resume while the input is still streaming", () => {
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            askUser({ state: "input-streaming", output: undefined }),
          ]),
        ],
      }),
    ).toBe(false);
  });

  it("waits for a sibling askUser that is still unanswered", () => {
    // Both answers belong in the same follow-up turn; resuming after the
    // first would send the second question's call with no result.
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            askUser({ toolCallId: "a" }),
            askUser({
              toolCallId: "b",
              state: "input-available",
              output: undefined,
            }),
          ]),
        ],
      }),
    ).toBe(false);
  });

  it("resumes once every sibling askUser is answered", () => {
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            askUser({ toolCallId: "a" }),
            askUser({ toolCallId: "b" }),
          ]),
        ],
      }),
    ).toBe(true);
  });

  it("only inspects the LAST step", () => {
    // An answered question in an earlier step must not re-trigger a
    // resume once a later step has run.
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            askUser(),
            { type: "step-start" },
            { type: "text", text: "thanks, booking it now" },
          ]),
        ],
      }),
    ).toBe(false);
  });

  it("does NOT resume when the last message is a user message", () => {
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [{ type: "step-start" }, askUser()]),
          msg("user", [{ type: "text", text: "actually stop" }]),
        ],
      }),
    ).toBe(false);
  });
});

describe("shouldAutoResume — regression guards", () => {
  it("does NOT resume for a plain completed tool call", () => {
    // The whole reason we don't use the SDK's
    // `lastAssistantMessageIsCompleteWithToolCalls`: this predicate is
    // evaluated at the end of EVERY stream, so a turn cut short after a
    // successful tool call (e.g. by the mid-stream compaction `stopWhen`)
    // would spuriously fire a second, billable run.
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            {
              type: "dynamic-tool",
              toolName: "navigate",
              toolCallId: "call-nav",
              state: "output-available",
              input: { url: "https://example.com" },
              output: { ok: true },
            },
          ]),
        ],
      }),
    ).toBe(false);
  });

  it("does NOT resume on a text-only turn", () => {
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            { type: "text", text: "here's the answer" },
          ]),
        ],
      }),
    ).toBe(false);
  });

  it("returns false on empty messages", () => {
    expect(shouldAutoResume({ messages: [] })).toBe(false);
  });
});

describe("shouldAutoResume — approvals (pre-existing behavior)", () => {
  const approved = {
    type: "dynamic-tool",
    toolName: "executeOnPage",
    toolCallId: "call-x",
    state: "approval-responded",
    input: { code: "1" },
    approval: { id: "ap-1", approved: true },
  };

  it("resumes after an approval response", () => {
    expect(
      shouldAutoResume({
        messages: [msg("assistant", [{ type: "step-start" }, approved])],
      }),
    ).toBe(true);
  });

  it("treats output-denied as terminal so a healed sibling can't strand the resume", () => {
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            approved,
            {
              type: "dynamic-tool",
              toolName: "closeTabs",
              toolCallId: "call-y",
              state: "output-denied",
              input: { target: "group" },
              approval: { id: "ap-2", approved: false },
            },
          ]),
        ],
      }),
    ).toBe(true);
  });

  it("does NOT resume while a sibling is still awaiting approval", () => {
    expect(
      shouldAutoResume({
        messages: [
          msg("assistant", [
            { type: "step-start" },
            approved,
            {
              type: "dynamic-tool",
              toolName: "closeTabs",
              toolCallId: "call-y",
              state: "approval-requested",
              input: { target: "group" },
              approval: { id: "ap-2" },
            },
          ]),
        ],
      }),
    ).toBe(false);
  });
});
