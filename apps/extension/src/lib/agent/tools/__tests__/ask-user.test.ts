import { describe, expect, it } from "vitest";
import {
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_TOOL_NAME,
  createAskUserTool,
} from "../ask-user";

/**
 * `askUser` is the only tool in the set registered WITHOUT an `execute`.
 * That single property is what makes the whole flow work — the SW agent
 * loop stops on a tool call with no result, which is how the run
 * terminates and hands the question to the renderer. If someone ever adds
 * an `execute` here, the loop would resolve the call itself and the user
 * would never see the card, so it gets an explicit test.
 */
describe("askUser tool shape", () => {
  it("has no execute (client-side tool)", () => {
    const tool = createAskUserTool() as Record<string, unknown>;
    expect(tool.execute).toBeUndefined();
  });

  it("declares an input and output schema", () => {
    const tool = createAskUserTool() as Record<string, unknown>;
    expect(tool.inputSchema).toBeDefined();
    expect(tool.outputSchema).toBeDefined();
  });
});

function parse(input: unknown) {
  const tool = createAskUserTool() as unknown as {
    inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  };
  return tool.inputSchema.safeParse(input);
}

const OPTIONS = [
  { label: "Nonstop", description: "Costs more" },
  { label: "One stop", description: "Cheapest" },
];

function question(overrides: Record<string, unknown> = {}) {
  return {
    question: "Which flight should I book?",
    header: "Flight",
    options: OPTIONS,
    ...overrides,
  };
}

describe("askUser input schema", () => {
  it("accepts a well-formed single question", () => {
    expect(parse({ questions: [question()] }).success).toBe(true);
  });

  it("defaults multiSelect to false", () => {
    const tool = createAskUserTool() as unknown as {
      inputSchema: {
        parse: (v: unknown) => { questions: Array<{ multiSelect: boolean }> };
      };
    };
    const parsed = tool.inputSchema.parse({ questions: [question()] });
    expect(parsed.questions[0].multiSelect).toBe(false);
  });

  it("rejects zero questions", () => {
    expect(parse({ questions: [] }).success).toBe(false);
  });

  it(`rejects more than ${ASK_USER_MAX_QUESTIONS} questions`, () => {
    const questions = Array.from(
      { length: ASK_USER_MAX_QUESTIONS + 1 },
      (_, i) => question({ question: `Question ${i}?` }),
    );
    expect(parse({ questions }).success).toBe(false);
  });

  it("rejects a single-option question", () => {
    expect(
      parse({ questions: [question({ options: [OPTIONS[0]] })] }).success,
    ).toBe(false);
  });

  it(`rejects more than ${ASK_USER_MAX_OPTIONS} options`, () => {
    const options = Array.from(
      { length: ASK_USER_MAX_OPTIONS + 1 },
      (_, i) => ({
        label: `Option ${i}`,
        description: "d",
      }),
    );
    expect(parse({ questions: [question({ options })] }).success).toBe(false);
  });

  it("rejects an over-long header", () => {
    expect(
      parse({
        questions: [question({ header: "A header far too long to be a chip" })],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate question texts", () => {
    // Answers are keyed back to questions by text, so duplicates make the
    // result ambiguous.
    expect(parse({ questions: [question(), question()] }).success).toBe(false);
  });

  it("rejects duplicate option labels within a question", () => {
    expect(
      parse({
        questions: [
          question({
            options: [
              { label: "Same", description: "a" },
              { label: "Same", description: "b" },
            ],
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("allows the same option label across DIFFERENT questions", () => {
    expect(
      parse({
        questions: [
          question({ question: "Outbound?" }),
          question({ question: "Return?" }),
        ],
      }).success,
    ).toBe(true);
  });
});

describe("askUser registration", () => {
  it("is registered in the parent tool set", async () => {
    const { createBrowserToolSet } = await import("../../agent-transport");
    expect(createBrowserToolSet(null)).toHaveProperty(ASK_USER_TOOL_NAME);
  });

  it("is never batchable", async () => {
    // `batch` executes its children itself, which a tool with no
    // `execute` cannot satisfy.
    const { BATCHABLE } = await import("../batch");
    expect(BATCHABLE).not.toContain(ASK_USER_TOOL_NAME);
  });

  it("is on the unconditional headless drop list", async () => {
    // Unlike the approval list, `autoApprove` must NOT bring this back:
    // there is no human on a headless surface at all.
    const { HEADLESS_NO_HUMAN_DROP_TOOLS } = await import(
      "../../agent-transport"
    );
    expect(HEADLESS_NO_HUMAN_DROP_TOOLS).toContain(ASK_USER_TOOL_NAME);
  });
});
