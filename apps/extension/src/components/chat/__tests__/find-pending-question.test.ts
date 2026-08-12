import type { AgentUIMessage } from "@/lib/agent/message-types";
import { describe, expect, it } from "vitest";
import { findPendingQuestion } from "../find-pending-question";

/**
 * Minimal AgentUIMessage builder. The SDK shape is wider than what the
 * helper inspects, so we cast through `unknown` to keep setup readable.
 */
function msg(
  role: "user" | "assistant" | "system",
  parts: Array<Record<string, unknown>>,
): AgentUIMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    role,
    parts,
  } as unknown as AgentUIMessage;
}

const OPTIONS = [
  { label: "Nonstop", description: "Costs more" },
  { label: "One stop", description: "Cheapest" },
];

function askUserPart(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "dynamic-tool",
    toolName: "askUser",
    state: "input-available",
    toolCallId: "call-1",
    input: {
      questions: [
        { question: "Which flight?", header: "Flight", options: OPTIONS },
      ],
    },
    ...overrides,
  };
}

describe("findPendingQuestion", () => {
  it("returns null on empty messages", () => {
    expect(findPendingQuestion([])).toBeNull();
  });

  it("returns null when there is no askUser part", () => {
    const messages = [
      msg("user", [{ type: "text", text: "book me a flight" }]),
      msg("assistant", [{ type: "text", text: "on it" }]),
    ];
    expect(findPendingQuestion(messages)).toBeNull();
  });

  it("returns the pending question for a dynamic-tool-shaped call", () => {
    const found = findPendingQuestion([msg("assistant", [askUserPart()])]);
    expect(found).not.toBeNull();
    expect(found?.toolCallId).toBe("call-1");
    expect(found?.questions).toHaveLength(1);
    expect(found?.questions[0].question).toBe("Which flight?");
    expect(found?.questions[0].options.map((o) => o.label)).toEqual([
      "Nonstop",
      "One stop",
    ]);
    // Absent in the input, defaulted by the parser.
    expect(found?.questions[0].multiSelect).toBe(false);
  });

  it("returns the pending question for a tool-askUser-shaped part", () => {
    // The live stream emits `tool-<name>` for statically-registered
    // tools; chatDb rehydration produces `dynamic-tool`. Both must work.
    const found = findPendingQuestion([
      msg("assistant", [
        askUserPart({ type: "tool-askUser", toolName: undefined }),
      ]),
    ]);
    expect(found?.toolCallId).toBe("call-1");
  });

  it("preserves multiSelect when set", () => {
    const found = findPendingQuestion([
      msg("assistant", [
        askUserPart({
          input: {
            questions: [
              {
                question: "Which filters?",
                header: "Filters",
                options: OPTIONS,
                multiSelect: true,
              },
            ],
          },
        }),
      ]),
    ]);
    expect(found?.questions[0].multiSelect).toBe(true);
  });

  it("ignores an input-streaming call", () => {
    // Partial JSON: options may be half-emitted. Answering against it
    // would submit a question set the model hadn't finished writing.
    const found = findPendingQuestion([
      msg("assistant", [askUserPart({ state: "input-streaming" })]),
    ]);
    expect(found).toBeNull();
  });

  it("ignores an already-answered call", () => {
    const found = findPendingQuestion([
      msg("assistant", [
        askUserPart({
          state: "output-available",
          output: { outcome: "answered", answers: [] },
        }),
      ]),
    ]);
    expect(found).toBeNull();
  });

  it("ignores non-askUser tools in input-available", () => {
    const found = findPendingQuestion([
      msg("assistant", [
        {
          type: "dynamic-tool",
          toolName: "navigate",
          state: "input-available",
          toolCallId: "call-x",
          input: { url: "https://example.com" },
        },
      ]),
    ]);
    expect(found).toBeNull();
  });

  it("returns null when the pending part is not on the LAST message", () => {
    // The load-bearing case: `addToolOutput` locates the part by scanning
    // `messages.at(-1)` only. If the user has since sent a message,
    // answering would write onto the wrong message — so the card must not
    // be offered at all.
    const messages = [
      msg("assistant", [askUserPart()]),
      msg("user", [{ type: "text", text: "never mind, do something else" }]),
    ];
    expect(findPendingQuestion(messages)).toBeNull();
  });

  it("returns the first unanswered question when a step has two", () => {
    // Two parallel askUser calls: the card resolves them one at a time,
    // and the second surfaces as soon as the first is answered. The
    // resume predicate waits for both (see should-auto-resume).
    const messages = [
      msg("assistant", [
        askUserPart({
          toolCallId: "call-answered",
          state: "output-available",
          output: { outcome: "answered", answers: [] },
        }),
        askUserPart({ toolCallId: "call-pending" }),
      ]),
    ];
    expect(findPendingQuestion(messages)?.toolCallId).toBe("call-pending");
  });

  it("drops malformed questions and returns null when none survive", () => {
    const messages = [
      msg("assistant", [
        askUserPart({
          input: {
            questions: [
              { question: "No options?", header: "Bad" },
              { question: "One option?", header: "Bad", options: [OPTIONS[0]] },
              { header: "No question text", options: OPTIONS },
            ],
          },
        }),
      ]),
    ];
    expect(findPendingQuestion(messages)).toBeNull();
  });

  it("keeps the valid questions when only some are malformed", () => {
    const found = findPendingQuestion([
      msg("assistant", [
        askUserPart({
          input: {
            questions: [
              { question: "No options", header: "Bad" },
              { question: "Which flight?", header: "Flight", options: OPTIONS },
            ],
          },
        }),
      ]),
    ]);
    expect(found?.questions).toHaveLength(1);
    expect(found?.questions[0].question).toBe("Which flight?");
  });

  it("rejects a question whose option labels collide", () => {
    // The card keys selection state by label, so duplicates make the
    // answer ambiguous. The tool schema rejects this too.
    const found = findPendingQuestion([
      msg("assistant", [
        askUserPart({
          input: {
            questions: [
              {
                question: "Which?",
                header: "Pick",
                options: [
                  { label: "Same", description: "a" },
                  { label: "Same", description: "b" },
                ],
              },
            ],
          },
        }),
      ]),
    ]);
    expect(found).toBeNull();
  });

  it("rejects more options than the schema bound allows", () => {
    const found = findPendingQuestion([
      msg("assistant", [
        askUserPart({
          input: {
            questions: [
              {
                question: "Which?",
                header: "Pick",
                options: [1, 2, 3, 4, 5].map((n) => ({
                  label: `Option ${n}`,
                  description: "d",
                })),
              },
            ],
          },
        }),
      ]),
    ]);
    expect(found).toBeNull();
  });

  it("ignores a user-role message even with a matching shape", () => {
    expect(findPendingQuestion([msg("user", [askUserPart()])])).toBeNull();
  });

  it("returns null when the part has no toolCallId", () => {
    const found = findPendingQuestion([
      msg("assistant", [askUserPart({ toolCallId: undefined })]),
    ]);
    expect(found).toBeNull();
  });

  it("tolerates a missing option description", () => {
    // `description` is required by the tool schema but not worth
    // discarding a whole question over — the card renders label-only.
    const found = findPendingQuestion([
      msg("assistant", [
        askUserPart({
          input: {
            questions: [
              {
                question: "Which?",
                header: "Pick",
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          },
        }),
      ]),
    ]);
    expect(found?.questions[0].options[0].description).toBe("");
  });
});
