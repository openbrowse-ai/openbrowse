import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModel, UIMessageChunk } from "ai";
import type { TodoItem } from "../../types";
import { runEvaluator } from "../completion-check/evaluator";
import {
  runCompletionCheck,
  shouldGate,
  type SkipReason,
} from "../completion-check";
import {
  buildEvaluatorSystemPrompt,
  buildEvaluatorUserPrompt,
} from "../completion-check/prompt";
import { completionCheckTelemetry } from "../completion-check/telemetry";
import {
  MAX_REJECTION_ROUNDS,
  type EvaluatorVerdict,
  type ToolCallTraceEntry,
} from "../completion-check/types";
import {
  buildCompletionCheckFeedbackMessage,
  emitCompletionCheckRunningChunk,
  observeChunkForCompletionCheck,
  COMPLETION_CHECK_PREFIX,
  runWithRejectionLoop,
  type RejectionLoopAgent,
} from "../compacting-transport";
import { setCurrentAgentModel } from "../current-agent-model";
import type { AgentUIMessage } from "../../types";

function makeTodo(content: string, status: TodoItem["status"]): TodoItem {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    content,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Build a `ToolCallTraceEntry` for tests with minimal boilerplate. Most
 * tests only care about `name` and `state`; this helper supplies sane
 * defaults for everything else.
 */
function makeTrace(
  name: string,
  opts: {
    inputSummary?: string;
    outputSummary?: string | null;
    state?: ToolCallTraceEntry["state"];
  } = {},
): ToolCallTraceEntry {
  return {
    name,
    inputSummary: opts.inputSummary ?? "{}",
    outputSummary:
      opts.outputSummary === undefined ? null : opts.outputSummary,
    state: opts.state ?? "completed",
  };
}

/**
 * Build a `MockLanguageModelV3` that returns a fixed verdict shape.
 *
 * Cast through `unknown` to `LanguageModel`: the SDK exports its own
 * `LanguageModel` union that's structurally compatible with V3 mocks
 * but not assignable without a TS hint.
 */
function mockEvaluatorModel(verdictJson: object): LanguageModel {
  // Cast through `any` for the doGenerate return — the AI SDK's V3 type
  // surface is in flux across @ai-sdk/provider versions and the strict
  // shape (especially `LanguageModelV3FinishReason`'s enum) often
  // mismatches between the version `ai/test` was built against and the
  // one resolved here. Test-only escape hatch.
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

describe("shouldGate", () => {
  it("skips when final text is empty (tool-only turn)", () => {
    const r = shouldGate({
      finalText: "   ",
      todos: [makeTodo("x", "in_progress")],
      toolCallTrace: [],
    });
    expect(r).toEqual({
      gate: false,
      reason: "no-final-text" satisfies SkipReason,
    });
  });

  it("skips trivial Q&A turns: no todos and no tool calls", () => {
    const r = shouldGate({
      finalText: "Hello!",
      todos: [],
      toolCallTrace: [],
    });
    expect(r).toEqual({
      gate: false,
      reason: "trigger-not-met" satisfies SkipReason,
    });
  });

  it("gates when todos exist (planned task)", () => {
    const r = shouldGate({
      finalText: "done",
      todos: [makeTodo("step", "completed")],
      toolCallTrace: [],
    });
    expect(r).toEqual({ gate: true });
  });

  it("gates when tool calls were made (acted on the world) even without todos", () => {
    const r = shouldGate({
      finalText: "Found the price.",
      todos: [],
      toolCallTrace: [makeTrace("extract")],
    });
    expect(r).toEqual({ gate: true });
  });

  it("gates when both todos and tool calls present", () => {
    const r = shouldGate({
      finalText: "done",
      todos: [makeTodo("step", "completed")],
      toolCallTrace: [makeTrace("snapshot")],
    });
    expect(r).toEqual({ gate: true });
  });

  // Iteration paused mid-task on a tool that needs human approval.
  // The SDK closes the stream after `tool-input-available` +
  // `tool-approval-request` without ever emitting an output chunk, so
  // the trace entry is left in `state: "pending"`. The drafted text
  // is mid-narration ("I'll now run X to do Y") and shouldn't trigger
  // the evaluator — the gate fires on the next iteration after
  // approval, when the tool actually has output.
  it("skips when any tool call is still pending (e.g. awaiting approval)", () => {
    const r = shouldGate({
      finalText: "I'll run executeOnPage to inspect the page now.",
      todos: [],
      toolCallTrace: [makeTrace("executeOnPage", { state: "pending" })],
    });
    expect(r).toEqual({
      gate: false,
      reason: "pending-tool-calls" satisfies SkipReason,
    });
  });

  // A pending entry poisons the gate even when other tools in the
  // same iteration completed. Multi-tool steps where one auto-allowed
  // tool ran and the next is approval-gated would otherwise leak
  // through.
  it("skips when at least one tool call is pending alongside completed ones", () => {
    const r = shouldGate({
      finalText: "Found the price; about to verify.",
      todos: [],
      toolCallTrace: [
        makeTrace("snapshot", { state: "completed" }),
        makeTrace("executeOnPage", { state: "pending" }),
      ],
    });
    expect(r).toEqual({
      gate: false,
      reason: "pending-tool-calls" satisfies SkipReason,
    });
  });

  // Pending takes priority over the trivial-turn skip too — a tool
  // call exists, just not in a terminal state. Prefer the more
  // specific "still in flight" reason for telemetry.
  it("skips with pending-tool-calls when the only trace entry is pending and no todos", () => {
    const r = shouldGate({
      finalText: "Running…",
      todos: [],
      toolCallTrace: [makeTrace("executeOnPage", { state: "pending" })],
    });
    expect(r).toEqual({
      gate: false,
      reason: "pending-tool-calls" satisfies SkipReason,
    });
  });
});

describe("runEvaluator (real, mocked LLM)", () => {
  afterEach(() => {
    setCurrentAgentModel(null);
  });

  it("returns optimistic approve when no model is available", async () => {
    setCurrentAgentModel(null);
    const v = await runEvaluator({
      originalRequest: "find me a keyboard",
      draftedResponse: "I found 2 of the 3 you asked for.",
      todos: [],
      toolCallTrace: [],
    });
    expect(v.decision).toBe("approve");
    expect(v.concerns).toEqual([]);
    expect(v.confidence).toBe(0);
    expect(v.reasoning).toMatch(/no language model/i);
  });

  it("approves when the model emits an approve verdict", async () => {
    const model = mockEvaluatorModel({
      decision: "approve",
      concerns: [],
      reasoning: "Looks complete.",
      confidence: 0.92,
    });
    const v = await runEvaluator({
      originalRequest: "do X",
      draftedResponse: "did X",
      todos: [],
      toolCallTrace: [],
      model,
    });
    expect(v.decision).toBe("approve");
    expect(v.concerns).toEqual([]);
    expect(v.confidence).toBeCloseTo(0.92);
  });

  it("rejects with structured concerns when the model emits a reject verdict", async () => {
    const model = mockEvaluatorModel({
      decision: "reject",
      concerns: [
        {
          dimension: "completeness",
          detail: "Asked for top 3 but listed 2.",
          userSummary: "Only 2 items listed but 3 were requested.",
          evidence: "draft mentions Logitech MX, Keychron K2",
        },
        {
          dimension: "evidenceGrounding",
          detail: "Price $149 not present in any tool call this turn.",
          userSummary: "The price ($149) wasn't verified on any page.",
        },
      ],
      reasoning: "Two specific gaps.",
      confidence: 0.78,
    });
    const v = await runEvaluator({
      originalRequest: "find top 3 keyboards",
      draftedResponse: "I found 2: Logitech MX ($149), Keychron K2.",
      todos: [],
      toolCallTrace: [],
      model,
    });
    expect(v.decision).toBe("reject");
    expect(v.concerns).toHaveLength(2);
    expect(v.concerns[0].dimension).toBe("completeness");
    expect(v.concerns[0].evidence).toContain("Logitech");
    expect(v.concerns[1].dimension).toBe("evidenceGrounding");
    expect(v.concerns[1].evidence).toBeUndefined();
  });

  it("repairs reject-with-empty-concerns into a synthetic completeness concern", async () => {
    const model = mockEvaluatorModel({
      decision: "reject",
      concerns: [],
      reasoning: "Just feels off.",
      confidence: 0.5,
    });
    const v = await runEvaluator({
      originalRequest: "do X",
      draftedResponse: "did Y",
      todos: [],
      toolCallTrace: [],
      model,
    });
    expect(v.decision).toBe("reject");
    expect(v.concerns).toHaveLength(1);
    expect(v.concerns[0].dimension).toBe("completeness");
  });

  it("schema requires userSummary on every concern", async () => {
    // Verdict missing userSummary on a concern: should fail schema
    // validation. The evaluator throws (caller in runCompletionCheck
    // catches and force-emits; here we just observe the throw).
    const model = mockEvaluatorModel({
      decision: "reject",
      concerns: [
        {
          dimension: "completeness",
          detail: "Missing required item.",
          // userSummary intentionally absent — should reject.
        },
      ],
      reasoning: "Missing field.",
      confidence: 0.8,
    });
    await expect(
      runEvaluator({
        originalRequest: "do X",
        draftedResponse: "did X",
        todos: [],
        toolCallTrace: [],
        model,
      }),
    ).rejects.toThrow();
  });

  it("synthetic-concern repair path includes userSummary", async () => {
    // The repair path fires when the model emits decision=reject but
    // concerns:[]. The synthesized concern must satisfy the new
    // required `userSummary` field — otherwise the type contract
    // breaks downstream.
    const model = mockEvaluatorModel({
      decision: "reject",
      concerns: [],
      reasoning: "Just feels off.",
      confidence: 0.5,
    });
    const v = await runEvaluator({
      originalRequest: "do X",
      draftedResponse: "did Y",
      todos: [],
      toolCallTrace: [],
      model,
    });
    expect(v.concerns).toHaveLength(1);
    expect(v.concerns[0].userSummary).toBeTruthy();
    expect(typeof v.concerns[0].userSummary).toBe("string");
    expect(v.concerns[0].userSummary.length).toBeGreaterThan(0);
  });

  it("threads userSummary through from the parsed verdict", async () => {
    const summary = "Hours might be off — site shows different hours.";
    const model = mockEvaluatorModel({
      decision: "reject",
      concerns: [
        {
          dimension: "surfaceAccuracy",
          detail: "Drafted hours conflict with site hours.",
          userSummary: summary,
          evidence: "site shows 8pm",
        },
      ],
      reasoning: "Hours mismatch.",
      confidence: 0.85,
    });
    const v = await runEvaluator({
      originalRequest: "find a cafe",
      draftedResponse: "Open until 7pm.",
      todos: [],
      toolCallTrace: [],
      model,
    });
    expect(v.concerns[0].userSummary).toBe(summary);
  });

  it("falls back to setCurrentAgentModel when model parameter is omitted", async () => {
    const model = mockEvaluatorModel({
      decision: "approve",
      concerns: [],
      reasoning: "From global model.",
      confidence: 0.8,
    });
    setCurrentAgentModel(model);
    const v = await runEvaluator({
      originalRequest: "do X",
      draftedResponse: "did X",
      todos: [],
      toolCallTrace: [],
    });
    expect(v.decision).toBe("approve");
    expect(v.reasoning).toContain("From global model");
  });

  it("with-tools mode: routes through generateText + Output.object and parses verdict", async () => {
    const verdict = {
      decision: "reject",
      concerns: [
        {
          dimension: "evidenceGrounding",
          detail: "Price $149 not in any tool output.",
          userSummary: "The price ($149) wasn't verified on any page.",
        },
      ],
      reasoning: "Could not ground the price claim.",
      confidence: 0.85,
    };
    const verdictText = JSON.stringify(verdict);

    // generateText uses doGenerate. Note V3 finishReason shape:
    // `{ unified, raw }` rather than a plain string. The earlier
    // generateObject tests work with the plain string because the
    // generateObject path tolerates both forms; generateText is
    // strict about the V3 shape.
    const model = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => ({
        content: [{ type: "text", text: verdictText }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10 },
          outputTokens: { total: 10 },
          totalTokens: { total: 20 },
        },
        warnings: [],
      })) as never,
    }) as unknown as LanguageModel;

    const v = await runEvaluator({
      originalRequest: "find cheapest keyboard",
      draftedResponse: "Cheapest is Logitech MX at $149.",
      todos: [],
      toolCallTrace: [],
      model,
      allowTools: true,
      tools: {
        // Cast to any: the structural Tool shape has many required
        // fields; the mock model never actually invokes the tool, so
        // this stub suffices for routing the with-tools branch.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snapshot: { description: "stub", parameters: {} } as any,
      },
      maxSteps: 3,
    });
    expect(v.decision).toBe("reject");
    expect(v.concerns).toHaveLength(1);
    expect(v.concerns[0].dimension).toBe("evidenceGrounding");
  });

  it("with-tools mode is skipped when tools map is empty (no-tools fast path)", async () => {
    const model = mockEvaluatorModel({
      decision: "approve",
      concerns: [],
      reasoning: "ok",
      confidence: 0.9,
    });
    // allowTools: true but tools is empty → no-tools generateObject
    // path. The mock above is configured for generateObject (doGenerate),
    // not generateText (doStream). If routing fell through to with-tools
    // we'd hit a runtime error.
    const v = await runEvaluator({
      originalRequest: "do X",
      draftedResponse: "did X",
      todos: [],
      toolCallTrace: [],
      model,
      allowTools: true,
      tools: {},
    });
    expect(v.decision).toBe("approve");
  });

  it("with-tools mode: two-stage fallback when first stage hits step cap without committing", async () => {
    // Simulate the production failure mode: generateText finishes its
    // last step with finishReason='tool-calls' (model wanted more
    // tools but stopWhen capped it), so result.output throws
    // NoOutputGeneratedError. The evaluator should catch that and run
    // a second-stage generateObject call to commit a verdict from the
    // accumulated work.
    const finalVerdict = {
      decision: "approve",
      concerns: [],
      reasoning: "Committed via second-stage fallback.",
      confidence: 0.7,
    };

    let callCount = 0;
    const model = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => {
        callCount++;
        if (callCount === 1) {
          // First call: generateText. Return a non-'stop' finishReason
          // so the SDK never invokes parseCompleteOutput, leaving
          // result.output undefined → throws NoOutputGeneratedError.
          return {
            content: [{ type: "text", text: "thinking..." }],
            finishReason: { unified: "length", raw: "length" },
            usage: {
              inputTokens: { total: 10 },
              outputTokens: { total: 5 },
              totalTokens: { total: 15 },
            },
            warnings: [],
          };
        }
        // Second call: generateObject second-stage commit. Return a
        // valid verdict so the fallback succeeds.
        return {
          content: [{ type: "text", text: JSON.stringify(finalVerdict) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 10 },
            outputTokens: { total: 10 },
            totalTokens: { total: 20 },
          },
          warnings: [],
        };
      }) as never,
    }) as unknown as LanguageModel;

    const v = await runEvaluator({
      originalRequest: "do X",
      draftedResponse: "did X",
      todos: [],
      toolCallTrace: [],
      model,
      allowTools: true,
      tools: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        snapshot: { description: "stub", parameters: {} } as any,
      },
      maxSteps: 1,
    });

    // Assert both calls happened: first stage (generateText) + second
    // stage (generateObject commit).
    expect(callCount).toBe(2);
    expect(v.decision).toBe("approve");
    expect(v.reasoning).toContain("second-stage");
    expect(v.confidence).toBeCloseTo(0.7);
  });

  it("with-tools mode: schema-validation errors are NOT caught by the fallback", async () => {
    // Distinct from NoOutputGeneratedError: if the model commits valid
    // text that doesn't match the schema, we want that to surface
    // (real bug) rather than silently fall through to second-stage.
    const badJson = JSON.stringify({
      decision: "approve",
      concerns: "not-an-array", // schema violation
      reasoning: "x",
      confidence: 0.5,
    });
    let callCount = 0;
    const model = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => {
        callCount++;
        return {
          content: [{ type: "text", text: badJson }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 10 },
            outputTokens: { total: 10 },
            totalTokens: { total: 20 },
          },
          warnings: [],
        };
      }) as never,
    }) as unknown as LanguageModel;

    await expect(
      runEvaluator({
        originalRequest: "do X",
        draftedResponse: "did X",
        todos: [],
        toolCallTrace: [],
        model,
        allowTools: true,
        tools: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          snapshot: { description: "stub", parameters: {} } as any,
        },
        maxSteps: 1,
      }),
    ).rejects.toThrow();
    // Only one call should have happened — the fallback didn't trigger.
    expect(callCount).toBe(1);
  });
});

describe("buildEvaluatorSystemPrompt", () => {
  it("includes every concern dimension by name", () => {
    const p = buildEvaluatorSystemPrompt({ hasTools: false });
    for (const dim of [
      "completeness",
      "planClosure",
      "evidenceGrounding",
      "noPrematureHandoff",
      "surfaceAccuracy",
    ]) {
      expect(p).toContain(`**${dim}**`);
    }
  });

  it("differs by hasTools", () => {
    const a = buildEvaluatorSystemPrompt({ hasTools: false });
    const b = buildEvaluatorSystemPrompt({ hasTools: true });
    expect(a).not.toBe(b);
    expect(b).toMatch(/read-only|snapshot|extract/i);
    expect(a).toContain("no tools available");
  });

  it("instructs to default to skepticism", () => {
    const p = buildEvaluatorSystemPrompt({ hasTools: false });
    expect(p.toLowerCase()).toContain("skeptic");
  });

  it("documents the userSummary field with observation-voice rules", () => {
    const p = buildEvaluatorSystemPrompt({ hasTools: false });
    // Mentions both fields the evaluator must produce.
    expect(p).toContain("`detail`");
    expect(p).toContain("`userSummary`");
    // Establishes the user-facing voice constraints.
    expect(p.toLowerCase()).toContain("observation voice");
    expect(p).toContain("Never mention \"the agent\"");
    // Provides at least one good and one bad example, so the model
    // can't generalize "agent voice is fine in some cases".
    expect(p.toLowerCase()).toContain("good `usersummary` example");
    expect(p.toLowerCase()).toContain("bad `usersummary` example");
    // Forbids prescriptive verbs explicitly.
    expect(p).toMatch(/should/);
    expect(p).toMatch(/needs to/);
  });
});

describe("buildEvaluatorUserPrompt", () => {
  it("renders empty todos and trace as readable placeholders", () => {
    const out = buildEvaluatorUserPrompt({
      originalRequest: "do X",
      draftedResponse: "did X",
      todos: [],
      toolCallTrace: [],
    });
    expect(out).toContain("(no todos in this conversation)");
    expect(out).toContain("(no tool calls in this turn)");
  });

  it("renders todo statuses uppercase", () => {
    const out = buildEvaluatorUserPrompt({
      originalRequest: "do X",
      draftedResponse: "did X",
      todos: [{ content: "first", status: "in_progress" }],
      toolCallTrace: [],
    });
    expect(out).toContain("[IN_PROGRESS] first");
  });

  it("includes original request and drafted response verbatim", () => {
    const out = buildEvaluatorUserPrompt({
      originalRequest: "find cheapest keyboard under $150",
      draftedResponse: "I found 2 candidates: Logitech MX, Keychron K2",
      todos: [],
      toolCallTrace: [],
    });
    expect(out).toContain("find cheapest keyboard under $150");
    expect(out).toContain("I found 2 candidates: Logitech MX, Keychron K2");
  });

  it("renders completed tool calls with both input and output", () => {
    const out = buildEvaluatorUserPrompt({
      originalRequest: "x",
      draftedResponse: "y",
      todos: [],
      toolCallTrace: [
        makeTrace("snapshot", {
          inputSummary: "{}",
          outputSummary: "<page text>...",
          state: "completed",
        }),
      ],
    });
    expect(out).toContain("1. snapshot");
    expect(out).toContain("input: {}");
    expect(out).toContain("output: <page text>...");
    // Completed entries should NOT be tagged with state.
    expect(out).not.toContain("snapshot [completed]");
  });

  it("renders errored tool calls with [errored] tag and error: prefix", () => {
    const out = buildEvaluatorUserPrompt({
      originalRequest: "x",
      draftedResponse: "y",
      todos: [],
      toolCallTrace: [
        makeTrace("extract", {
          inputSummary: '{"selector":".missing"}',
          outputSummary: "Element not found",
          state: "errored",
        }),
      ],
    });
    expect(out).toContain("extract [errored]");
    expect(out).toContain("error: Element not found");
  });

  it("renders denied tool calls with [denied] tag and explanatory line", () => {
    const out = buildEvaluatorUserPrompt({
      originalRequest: "x",
      draftedResponse: "y",
      todos: [],
      toolCallTrace: [
        makeTrace("navigate", {
          inputSummary: '{"url":"https://x.com"}',
          outputSummary: null,
          state: "denied",
        }),
      ],
    });
    expect(out).toContain("navigate [denied]");
    expect(out).toContain("user denied");
  });

  it("renders pending tool calls with [pending] tag and explanatory line", () => {
    const out = buildEvaluatorUserPrompt({
      originalRequest: "x",
      draftedResponse: "y",
      todos: [],
      toolCallTrace: [
        makeTrace("snapshot", {
          inputSummary: "{}",
          outputSummary: null,
          state: "pending",
        }),
      ],
    });
    expect(out).toContain("snapshot [pending]");
    expect(out).toContain("did not complete");
  });

  it("preface tells the evaluator the trace includes outputs", () => {
    const out = buildEvaluatorUserPrompt({
      originalRequest: "x",
      draftedResponse: "y",
      todos: [],
      toolCallTrace: [],
    });
    // The preface is what nudges the evaluator NOT to re-call tools.
    expect(out.toLowerCase()).toContain("captured outputs");
  });
});

describe("completionCheckTelemetry", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    await completionCheckTelemetry._resetForTests();
  });

  it("records and lists rows for a conversation, sorted by timestamp", async () => {
    await completionCheckTelemetry.record({
      conversationId: "c1",
      turnIndex: 0,
      rejectionRound: 0,
      outcomeKind: "approved",
      verdict: {
        decision: "approve",
        concerns: [],
        reasoning: "ok",
        confidence: 0.9,
      },
      timestamp: 1000,
    });
    await completionCheckTelemetry.record({
      conversationId: "c1",
      turnIndex: 1,
      rejectionRound: 0,
      outcomeKind: "rejected",
      verdict: {
        decision: "reject",
        concerns: [
          {
            dimension: "completeness",
            detail: "missing item",
            userSummary: "An item is missing.",
          },
        ],
        reasoning: "incomplete",
        confidence: 0.8,
      },
      timestamp: 2000,
    });
    const rows = await completionCheckTelemetry.listForConversation("c1");
    expect(rows.map((r) => r.outcomeKind)).toEqual(["approved", "rejected"]);
    expect(rows[1].concernDimensions).toEqual(["completeness"]);
  });

  it("aggregate counts outcomes and dimensions", async () => {
    await completionCheckTelemetry.record({
      conversationId: "c1",
      turnIndex: 0,
      rejectionRound: 0,
      outcomeKind: "approved",
      verdict: {
        decision: "approve",
        concerns: [],
        reasoning: "ok",
        confidence: 0.9,
      },
    });
    await completionCheckTelemetry.record({
      conversationId: "c1",
      turnIndex: 1,
      rejectionRound: 0,
      outcomeKind: "rejected",
      verdict: {
        decision: "reject",
        concerns: [
          { dimension: "completeness", detail: "x", userSummary: "x." },
          {
            dimension: "evidenceGrounding",
            detail: "y",
            userSummary: "y.",
          },
        ],
        reasoning: "z",
        confidence: 0.8,
      },
    });
    await completionCheckTelemetry.record({
      conversationId: "c1",
      turnIndex: 2,
      rejectionRound: 0,
      outcomeKind: "skipped",
      verdict: null,
      skipReason: "trigger-not-met",
    });
    const agg = await completionCheckTelemetry.aggregate();
    expect(agg.totalVerdicts).toBe(3);
    expect(agg.byOutcome.approved).toBe(1);
    expect(agg.byOutcome.rejected).toBe(1);
    expect(agg.byOutcome.skipped).toBe(1);
    expect(agg.byDimension.completeness).toBe(1);
    expect(agg.byDimension.evidenceGrounding).toBe(1);
    expect(agg.byDimension.planClosure).toBe(0);
  });

  it("aggregate respects sinceMs filter", async () => {
    await completionCheckTelemetry.record({
      conversationId: "c1",
      turnIndex: 0,
      rejectionRound: 0,
      outcomeKind: "approved",
      verdict: {
        decision: "approve",
        concerns: [],
        reasoning: "old",
        confidence: 1,
      },
      timestamp: 1000,
    });
    await completionCheckTelemetry.record({
      conversationId: "c1",
      turnIndex: 1,
      rejectionRound: 0,
      outcomeKind: "approved",
      verdict: {
        decision: "approve",
        concerns: [],
        reasoning: "new",
        confidence: 1,
      },
      timestamp: 5000,
    });
    const agg = await completionCheckTelemetry.aggregate({ sinceMs: 3000 });
    expect(agg.totalVerdicts).toBe(1);
  });

  it("clear empties the store", async () => {
    await completionCheckTelemetry.record({
      conversationId: "c1",
      turnIndex: 0,
      rejectionRound: 0,
      outcomeKind: "approved",
      verdict: {
        decision: "approve",
        concerns: [],
        reasoning: "ok",
        confidence: 1,
      },
    });
    await completionCheckTelemetry.clear();
    const rows = await completionCheckTelemetry.listAll();
    expect(rows).toEqual([]);
  });
});

describe("runCompletionCheck (real evaluator with mocked LLM)", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    await completionCheckTelemetry._resetForTests();
    setCurrentAgentModel(null);
  });

  afterEach(() => {
    setCurrentAgentModel(null);
  });

  it("skips with trigger-not-met when no todos and no tool calls", async () => {
    const out = await runCompletionCheck({
      conversationId: "c1",
      turnIndex: 0,
      rejectionRound: 0,
      originalRequest: "what is 2+2",
      draftedResponse: "4",
      todos: [],
      toolCallTrace: [],
    });
    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") expect(out.reason).toBe("trigger-not-met");
    const rows = await completionCheckTelemetry.listForConversation("c1");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcomeKind).toBe("skipped");
    expect(rows[0].skipReason).toBe("trigger-not-met");
  });

  // Reproduces the bug where the gate fired against an iteration
  // that was paused on tool approval. The drafted text is non-empty
  // and the trace has a tool call, but the call is in `pending`
  // state because the user hasn't clicked Allow yet. Skip cleanly
  // and record the new telemetry skip reason.
  it("skips with pending-tool-calls when the iteration is paused on tool approval", async () => {
    const out = await runCompletionCheck({
      conversationId: "c-pending",
      turnIndex: 0,
      rejectionRound: 0,
      originalRequest: "open bookface and find a profile",
      draftedResponse: "I'll run executeOnPage to inspect the listing.",
      todos: [],
      toolCallTrace: [
        {
          name: "executeOnPage",
          inputSummary: '{"tab":"t1"}',
          outputSummary: null,
          state: "pending",
        },
      ],
    });
    expect(out.kind).toBe("skipped");
    if (out.kind === "skipped") {
      expect(out.reason).toBe("pending-tool-calls");
    }
    const rows = await completionCheckTelemetry.listForConversation("c-pending");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcomeKind).toBe("skipped");
    expect(rows[0].skipReason).toBe("pending-tool-calls");
  });

  it("approves when the trigger fires and the evaluator approves", async () => {
    const evalModel = mockEvaluatorModel({
      decision: "approve",
      concerns: [],
      reasoning: "ok",
      confidence: 0.9,
    });
    const out = await runCompletionCheck({
      conversationId: "c2",
      turnIndex: 0,
      rejectionRound: 0,
      originalRequest: "do X",
      draftedResponse: "done",
      todos: [makeTodo("step", "completed")],
      toolCallTrace: [],
      evaluatorModel: evalModel,
    });
    expect(out.kind).toBe("approved");
    const rows = await completionCheckTelemetry.listForConversation("c2");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcomeKind).toBe("approved");
  });

  it("rejects when evaluator emits reject + concerns and budget remains", async () => {
    const evalModel = mockEvaluatorModel({
      decision: "reject",
      concerns: [
        {
          dimension: "completeness",
          detail: "missing item",
          userSummary: "An item is missing.",
        },
      ],
      reasoning: "x",
      confidence: 0.8,
    });
    const out = await runCompletionCheck({
      conversationId: "c3",
      turnIndex: 0,
      rejectionRound: 0,
      originalRequest: "do X",
      draftedResponse: "done",
      todos: [makeTodo("step", "completed")],
      toolCallTrace: [],
      evaluatorModel: evalModel,
    });
    expect(out.kind).toBe("rejected");
    if (out.kind === "rejected") {
      expect(out.verdict.concerns).toHaveLength(1);
      expect(out.rejectionRound).toBe(0);
    }
    const rows = await completionCheckTelemetry.listForConversation("c3");
    expect(rows[0].concernDimensions).toEqual(["completeness"]);
  });

  it("force-emits when rejection budget is exceeded", async () => {
    const evalModel = mockEvaluatorModel({
      decision: "reject",
      concerns: [
        {
          dimension: "completeness",
          detail: "still incomplete",
          userSummary: "Still incomplete.",
        },
      ],
      reasoning: "x",
      confidence: 0.8,
    });
    // The cap is `MAX_REJECTION_ROUNDS` (3). Calling with the last
    // round under the cap (round = MAX-1) means `round + 1 >= MAX` and
    // the gate force-emits.
    const out = await runCompletionCheck({
      conversationId: "c4",
      turnIndex: 0,
      rejectionRound: MAX_REJECTION_ROUNDS - 1,
      originalRequest: "do X",
      draftedResponse: "done",
      todos: [makeTodo("step", "completed")],
      toolCallTrace: [],
      evaluatorModel: evalModel,
    });
    expect(out.kind).toBe("force-emitted");
    if (out.kind === "force-emitted") {
      expect(out.reason).toBe("max-rounds-exceeded");
    }
  });

  it("force-emits with reason=evaluator-error when evaluator throws", async () => {
    const m = new MockLanguageModelV3({
      doGenerate: (async () => {
        throw new Error("provider down");
      }) as never,
    }) as unknown as LanguageModel;
    const out = await runCompletionCheck({
      conversationId: "c5",
      turnIndex: 0,
      rejectionRound: 0,
      originalRequest: "do X",
      draftedResponse: "done",
      todos: [makeTodo("step", "completed")],
      toolCallTrace: [],
      evaluatorModel: m,
    });
    expect(out.kind).toBe("force-emitted");
    if (out.kind === "force-emitted") {
      expect(out.reason).toBe("evaluator-error");
      expect(out.verdict.confidence).toBe(0);
    }
  });

  it("verdict scores field stays unpopulated", async () => {
    const evalModel = mockEvaluatorModel({
      decision: "approve",
      concerns: [],
      reasoning: "ok",
      confidence: 1,
    });
    const out = await runCompletionCheck({
      conversationId: "c6",
      turnIndex: 0,
      rejectionRound: 0,
      originalRequest: "do X",
      draftedResponse: "done",
      todos: [makeTodo("step", "completed")],
      toolCallTrace: [],
      evaluatorModel: evalModel,
    });
    if (out.kind !== "approved") throw new Error("expected approve");
    const v: EvaluatorVerdict = out.verdict;
    expect(v.scores).toBeUndefined();
    expect(v.trend).toBeUndefined();
  });
});

describe("observeChunkForCompletionCheck", () => {
  function freshState() {
    return {
      textBuffers: new Map<string, string>(),
      lastTextMessageId: undefined as string | undefined,
      toolCalls: new Map<string, ToolCallTraceEntry>(),
      toolCallOrder: [] as string[],
    };
  }

  function adapter(s: ReturnType<typeof freshState>) {
    return {
      textBuffers: s.textBuffers,
      setLastTextMessageId: (id: string) => {
        s.lastTextMessageId = id;
      },
      toolCalls: s.toolCalls,
      toolCallOrder: s.toolCallOrder,
    };
  }

  /** Convenience accessor for assertions: materialize entries in order. */
  function materialize(
    s: ReturnType<typeof freshState>,
  ): ToolCallTraceEntry[] {
    return s.toolCallOrder
      .map((id) => s.toolCalls.get(id))
      .filter((e): e is ToolCallTraceEntry => e !== undefined);
  }

  it("accumulates text deltas keyed by message id", () => {
    const s = freshState();
    observeChunkForCompletionCheck(
      // The transport observer treats unknown chunk fields as opaque; the
      // shape here matches the AI SDK's text-streaming chunks well enough.
      { type: "text-start", id: "m1" } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      { type: "text-delta", id: "m1", delta: "hello " } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      { type: "text-delta", id: "m1", delta: "world" } as never,
      adapter(s),
    );
    expect(s.textBuffers.get("m1")).toBe("hello world");
    expect(s.lastTextMessageId).toBe("m1");
  });

  it("captures tool calls with truncated input summaries", () => {
    const s = freshState();
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "snapshot",
        input: { mode: "viewport" },
      } as never,
      adapter(s),
    );
    const trace = materialize(s);
    expect(trace).toHaveLength(1);
    expect(trace[0].name).toBe("snapshot");
    expect(trace[0].inputSummary).toContain("viewport");
    expect(trace[0].state).toBe("pending");
    expect(trace[0].outputSummary).toBeNull();
  });

  it("pairs tool input with output by toolCallId; flips state to completed", () => {
    const s = freshState();
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "extract",
        input: { selector: ".price" },
      } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      {
        type: "tool-output-available",
        toolCallId: "tc1",
        output: { price: "$29.99" },
      } as never,
      adapter(s),
    );
    const trace = materialize(s);
    expect(trace).toHaveLength(1);
    expect(trace[0].state).toBe("completed");
    expect(trace[0].outputSummary).toContain("$29.99");
  });

  it("captures tool errors as state=errored with error text", () => {
    const s = freshState();
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "extract",
        input: { selector: ".missing" },
      } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      {
        type: "tool-output-error",
        toolCallId: "tc1",
        errorText: "Element not found",
      } as never,
      adapter(s),
    );
    const trace = materialize(s);
    expect(trace[0].state).toBe("errored");
    expect(trace[0].outputSummary).toBe("Element not found");
  });

  it("captures tool denial as state=denied with null output", () => {
    const s = freshState();
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "navigate",
        input: { url: "https://example.com" },
      } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      {
        type: "tool-output-denied",
        toolCallId: "tc1",
      } as never,
      adapter(s),
    );
    const trace = materialize(s);
    expect(trace[0].state).toBe("denied");
    expect(trace[0].outputSummary).toBeNull();
  });

  it("orphaned input (no matching output before stream end) stays pending", () => {
    const s = freshState();
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "snapshot",
        input: {},
      } as never,
      adapter(s),
    );
    // Stream ends without an output chunk for tc1.
    const trace = materialize(s);
    expect(trace[0].state).toBe("pending");
    expect(trace[0].outputSummary).toBeNull();
  });

  it("hard-truncates oversized outputs with truncation marker", () => {
    const s = freshState();
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "tc1",
        toolName: "readPage",
        input: {},
      } as never,
      adapter(s),
    );
    const huge = "x".repeat(2000);
    observeChunkForCompletionCheck(
      {
        type: "tool-output-available",
        toolCallId: "tc1",
        output: huge,
      } as never,
      adapter(s),
    );
    const trace = materialize(s);
    // Should be capped (800 chars + truncation marker).
    expect(trace[0].outputSummary?.length ?? 0).toBeLessThan(huge.length);
    expect(trace[0].outputSummary).toMatch(/truncated/);
  });

  it("preserves chunk-arrival order across multiple interleaved tools", () => {
    const s = freshState();
    // Three tools start, then their outputs arrive out of order.
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "a",
        toolName: "snapshot",
        input: {},
      } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "b",
        toolName: "extract",
        input: {},
      } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      {
        type: "tool-input-available",
        toolCallId: "c",
        toolName: "readPage",
        input: {},
      } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      { type: "tool-output-available", toolCallId: "b", output: "B" } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      { type: "tool-output-available", toolCallId: "a", output: "A" } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      { type: "tool-output-available", toolCallId: "c", output: "C" } as never,
      adapter(s),
    );
    const trace = materialize(s);
    expect(trace.map((t) => t.name)).toEqual([
      "snapshot",
      "extract",
      "readPage",
    ]);
    expect(trace.map((t) => t.outputSummary)).toEqual(["A", "B", "C"]);
  });

  it("ignores unrecognized chunk types without throwing", () => {
    const s = freshState();
    expect(() =>
      observeChunkForCompletionCheck(
        { type: "some-future-chunk-type" } as never,
        adapter(s),
      ),
    ).not.toThrow();
    expect(materialize(s)).toHaveLength(0);
    expect(s.textBuffers.size).toBe(0);
  });

  it("output chunk without a matching input is dropped", () => {
    const s = freshState();
    // Output arrives without any prior input chunk.
    observeChunkForCompletionCheck(
      {
        type: "tool-output-available",
        toolCallId: "ghost",
        output: "data",
      } as never,
      adapter(s),
    );
    expect(materialize(s)).toHaveLength(0);
  });

  it("multiple text messages: lastTextMessageId tracks the most recent", () => {
    const s = freshState();
    observeChunkForCompletionCheck(
      { type: "text-start", id: "m1" } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      { type: "text-delta", id: "m1", delta: "first" } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      { type: "text-start", id: "m2" } as never,
      adapter(s),
    );
    observeChunkForCompletionCheck(
      { type: "text-delta", id: "m2", delta: "second" } as never,
      adapter(s),
    );
    expect(s.lastTextMessageId).toBe("m2");
    expect(s.textBuffers.get("m1")).toBe("first");
    expect(s.textBuffers.get("m2")).toBe("second");
  });
});

afterEach(async () => {
  // Tighten test isolation for the IndexedDB-using suites.
  await completionCheckTelemetry._resetForTests();
});

describe("buildCompletionCheckFeedbackMessage", () => {
  it("emits the canonical prefix the system prompt promises", () => {
    const m = buildCompletionCheckFeedbackMessage(
      {
        decision: "reject",
        concerns: [
          {
            dimension: "completeness",
            detail: "x",
            userSummary: "x.",
          },
        ],
        reasoning: "incomplete",
        confidence: 0.8,
      },
      1,
    );
    const text = m.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toContain(COMPLETION_CHECK_PREFIX);
    expect(text).toContain("(round 1)");
    expect(text).toContain("completeness: x");
    expect(text).toContain("Continue working");
  });

  it("includes evidence when present and skips the line when absent", () => {
    const m = buildCompletionCheckFeedbackMessage(
      {
        decision: "reject",
        concerns: [
          {
            dimension: "evidenceGrounding",
            detail: "price unverified",
            userSummary: "Price isn't verified.",
            evidence: "draft says $149",
          },
          {
            dimension: "completeness",
            detail: "missing 3rd item",
            userSummary: "Third item missing.",
          },
        ],
        reasoning: "issues",
        confidence: 0.7,
      },
      2,
    );
    const text = (m.parts[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Evidence: draft says $149");
    // No "Evidence:" line for concerns without one
    const completenessLineIdx = text.indexOf("completeness: missing 3rd item");
    const tail = text.slice(completenessLineIdx);
    // Next "- " (or end) marks the next concern; nothing in between is "Evidence:"
    const between = tail.split("\n- ")[0];
    expect(between).not.toContain("Evidence:");
  });

  it("produces a stable user-role message with a fresh id", () => {
    const v: EvaluatorVerdict = {
      decision: "reject",
      concerns: [
        {
          dimension: "completeness",
          detail: "x",
          userSummary: "x.",
        },
      ],
      reasoning: "x",
      confidence: 0.5,
    };
    const a = buildCompletionCheckFeedbackMessage(v, 1);
    const b = buildCompletionCheckFeedbackMessage(v, 1);
    expect(a.role).toBe("user");
    expect(b.role).toBe("user");
    expect(a.id).not.toBe(b.id);
  });
});

describe("runWithRejectionLoop (transport integration)", () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    await completionCheckTelemetry._resetForTests();
    setCurrentAgentModel(null);
  });

  /**
   * Build a `RejectionLoopAgent` stub whose `stream()` returns one
   * scripted iteration per call. Each iteration emits a fixed list of
   * `UIMessageChunk`s, ending with a final-text `text-delta`/`text-end`
   * pair so the loop's observer extracts a non-empty `finalText`.
   *
   * Captures every `prompt` it received so tests can assert messages
   * grew with each rejection round.
   */
  function makeStubAgent(textPerIteration: string[]): RejectionLoopAgent & {
    promptHistory: unknown[];
    callCount: number;
  } {
    let i = 0;
    const promptHistory: unknown[] = [];
    return {
      tools: {},
      promptHistory,
      get callCount() {
        return i;
      },
      stream: async ({ prompt }) => {
        promptHistory.push(prompt);
        const text = textPerIteration[i] ?? textPerIteration.at(-1) ?? "";
        i++;
        const id = `m-${i}`;
        const chunks: UIMessageChunk[] = [
          { type: "text-start", id } as never,
          { type: "text-delta", id, delta: text } as never,
          { type: "text-end", id } as never,
        ];
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

  function userMessage(text: string): AgentUIMessage {
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }],
    } as AgentUIMessage;
  }

  function approveModel(): LanguageModel {
    return mockEvaluatorModel({
      decision: "approve",
      concerns: [],
      reasoning: "ok",
      confidence: 0.9,
    });
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
                    detail: "missing 3rd item",
                    userSummary: "Third item missing.",
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

  function alwaysRejectModel(): LanguageModel {
    return mockEvaluatorModel({
      decision: "reject",
      concerns: [
        {
          dimension: "completeness",
          detail: "still incomplete",
          userSummary: "Still incomplete.",
        },
      ],
      reasoning: "x",
      confidence: 0.8,
    });
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

  it("approve verdict ⇒ exactly one agent iteration, stream forwards chunks", async () => {
    const agent = makeStubAgent(["The first answer."]);
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c1",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        // Ensure trigger fires: include a tool call.
        todos: [],
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: approveModel(),
      }),
    });
    const chunks = await drainStream(stream);
    expect(agent.callCount).toBe(1);
    const deltas = chunks.filter(
      (c) => (c as { type: string }).type === "text-delta",
    );
    expect(deltas).toHaveLength(1);
  });

  it("reject → approve ⇒ two agent iterations; second prompt has completion-check feedback; rejection chunk emitted", async () => {
    const agent = makeStubAgent(["First answer.", "Second answer."]);
    // Create the evaluator model once outside the builder so its
    // reject→approve sequencing persists across rounds.
    const evalModel = rejectThenApproveModel();
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c2",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        todos: [],
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: evalModel,
      }),
    });
    const chunks = await drainStream(stream);
    expect(agent.callCount).toBe(2);

    // Second iteration's prompt must include completion-check feedback.
    const secondPrompt = JSON.stringify(agent.promptHistory[1]);
    expect(secondPrompt).toContain(COMPLETION_CHECK_PREFIX);
    expect(secondPrompt).toContain("missing 3rd item");

    const deltas = chunks.filter(
      (c) => (c as { type: string }).type === "text-delta",
    );
    expect(deltas).toHaveLength(2);

    const rejectionChunks = chunks.filter(
      (c) => (c as { type: string }).type === "data-completion-check-rejection",
    );
    expect(rejectionChunks).toHaveLength(1);
    const rejectionData = (rejectionChunks[0] as {
      data: {
        concerns: { dimension: string }[];
        rejectionRound: number;
        forceEmittedNext?: boolean;
      };
    }).data;
    expect(rejectionData.rejectionRound).toBe(1);
    expect(rejectionData.forceEmittedNext).toBe(false);
    expect(rejectionData.concerns[0].dimension).toBe("completeness");
  });

  it("reject loop respects MAX_REJECTION_ROUNDS and force-emits", async () => {
    // With cap=3 and always-reject, expect 3 agent iterations
    // (rounds 0, 1, 2 — round 2 being the cap-exceeded force-emit).
    const agent = makeStubAgent(
      Array.from({ length: 5 }, (_, k) => `Bad ${k}.`),
    );
    const evalModel = alwaysRejectModel();
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c3-rejectloop",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        todos: [],
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: evalModel,
      }),
    });
    const chunks = await drainStream(stream);
    expect(agent.callCount).toBe(MAX_REJECTION_ROUNDS);

    const rows = await completionCheckTelemetry.listForConversation(
      "c3-rejectloop",
    );
    expect(rows.some((r) => r.outcomeKind === "force-emitted")).toBe(true);

    const rejectionChunks = chunks.filter(
      (c) => (c as { type: string }).type === "data-completion-check-rejection",
    ) as Array<{
      data: { rejectionRound: number; forceEmittedNext?: boolean };
    }>;
    // For cap=3: rounds 1, 2 (continuing) and round 3 (force-emit final).
    expect(rejectionChunks).toHaveLength(MAX_REJECTION_ROUNDS);
    expect(rejectionChunks.at(-1)?.data.forceEmittedNext).toBe(true);
    expect(rejectionChunks.at(-1)?.data.rejectionRound).toBe(
      MAX_REJECTION_ROUNDS,
    );
  });

  it("aborted signal closes the stream without further iterations", async () => {
    const agent = makeStubAgent(["First.", "Second."]);
    const ctrl = new AbortController();
    const evalModel = alwaysRejectModel();
    let evalCallCount = 0;
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: ctrl.signal,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => {
        evalCallCount++;
        // Reject the first iteration but abort before the loop checks.
        ctrl.abort();
        return {
          conversationId: "c4",
          turnIndex: 0,
          rejectionRound: 0,
          originalRequest: "do X",
          draftedResponse: "(filled by loop)",
          todos: [],
          toolCallTrace: [makeTrace("snapshot")],
          evaluatorModel: evalModel,
        };
      },
    });
    await drainStream(stream);
    expect(agent.callCount).toBe(1);
    expect(evalCallCount).toBe(1);
  });

  it("user stop mid-stream ⇒ stream closes WITHOUT running the completion check", async () => {
    // Reproduces the bug: pressing Stop aborts the in-flight agent
    // stream, but the loop only checked `abortSignal.aborted` at the
    // TOP of the iteration — so after the partial stream drained it
    // fell straight through to runCompletionCheck, evaluating a draft
    // the user explicitly abandoned. The fix re-checks the abort signal
    // after pipeAndObserve returns and closes the stream first.
    const ctrl = new AbortController();

    // Agent stub that aborts the controller *during* its stream, then
    // still emits a final-text pair — exactly what happens when the
    // user clicks Stop while the model is mid-response.
    const agent: RejectionLoopAgent & { callCount: number } = {
      tools: {},
      get callCount() {
        return callCount;
      },
      stream: async () => {
        callCount++;
        return {
          toUIMessageStream: () =>
            new ReadableStream<UIMessageChunk>({
              start(controller) {
                const id = "m-abort";
                controller.enqueue({ type: "text-start", id } as never);
                controller.enqueue({
                  type: "text-delta",
                  id,
                  delta: "partial answer",
                } as never);
                // User presses Stop here, mid-stream.
                ctrl.abort();
                controller.enqueue({ type: "text-end", id } as never);
                controller.close();
              },
            }),
        };
      },
    };
    let callCount = 0;

    // Counting evaluator model: if the gate runs, doGenerate fires.
    let evalCallCount = 0;
    const evalModel = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => {
        evalCallCount++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decision: "approve",
                concerns: [],
                reasoning: "ok",
                confidence: 0.9,
              }),
            },
          ],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          warnings: [],
        };
      }) as never,
    }) as unknown as LanguageModel;

    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: ctrl.signal,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c-abort-midstream",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        todos: [],
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: evalModel,
      }),
    });
    await drainStream(stream);

    expect(agent.callCount).toBe(1);
    // The completion check must NOT have run on the abandoned draft.
    expect(evalCallCount).toBe(0);
  });

  it("stop landing DURING the awaited buildCompletionCheckInput ⇒ no completion check", async () => {
    // Production timing: the agent stream finishes cleanly (model
    // produced its draft), so the abort is NOT set when the loop's
    // post-stream guard runs. Then `buildCompletionCheckInput` awaits a
    // chatDb read, and the user presses Stop *during* that await. A
    // single guard before buildCompletionCheckInput misses this; the
    // loop needs a second guard after the input is built, before
    // runCompletionCheck fires the evaluator.
    const ctrl = new AbortController();
    const agent = makeStubAgent(["The complete answer."]);

    let evalCallCount = 0;
    const evalModel = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => {
        evalCallCount++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decision: "approve",
                concerns: [],
                reasoning: "ok",
                confidence: 0.9,
              }),
            },
          ],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          warnings: [],
        };
      }) as never,
    }) as unknown as LanguageModel;

    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: ctrl.signal,
      pinnedConversationId: null,
      // Async build that the user interrupts mid-await — exactly the
      // chatDb-read window in production.
      buildCompletionCheckInput: async () => {
        await Promise.resolve();
        ctrl.abort();
        return {
          conversationId: "c-abort-during-build",
          turnIndex: 0,
          rejectionRound: 0,
          originalRequest: "do X",
          draftedResponse: "(filled by loop)",
          todos: [],
          toolCallTrace: [makeTrace("snapshot")],
          evaluatorModel: evalModel,
        };
      },
    });
    await drainStream(stream);

    expect(agent.callCount).toBe(1);
    expect(evalCallCount).toBe(0);
  });

  it("stop landing DURING the evaluator call ⇒ stream closes silently, no rejection/force-emit chunk", async () => {
    // The abort lands after both guards pass, while the evaluator LLM
    // call is in flight. The evaluator's abortSignal cancels it (throws
    // AbortError), which runCompletionCheck catches and turns into a
    // force-emit fallback. On a user-initiated stop we must NOT surface
    // that fallback as a visible completion-check block — the user
    // cancelled, so close silently.
    const ctrl = new AbortController();
    const agent = makeStubAgent(["The complete answer."]);

    // Evaluator model whose doGenerate aborts then throws an
    // AbortError, mimicking a stop arriving mid-evaluation.
    const evalModel = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => {
        ctrl.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }) as never,
    }) as unknown as LanguageModel;

    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: ctrl.signal,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c-abort-during-eval",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        todos: [],
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: evalModel,
      }),
    });
    const chunks = await drainStream(stream);

    // No visible completion-check rejection/force-emit block on a
    // user-cancelled run.
    const rejection = chunks.filter(
      (c) =>
        (c as { type: string }).type === "data-completion-check-rejection",
    );
    expect(rejection).toHaveLength(0);
  });

  it("abort lands during async buildCompletionCheckInput ⇒ no running pill, evaluator not called", async () => {
    // Production timing: the agent stream finishes naturally (no abort
    // chunk), the post-stream guard passes, then `buildCompletionCheckInput`
    // awaits a chatDb read during which the user presses Stop. The loop
    // must not flash a "Running quality check…" pill nor invoke the
    // evaluator for a turn the user abandoned.
    const ctrl = new AbortController();
    const agent = makeStubAgent(["The complete answer."]);

    let evalCallCount = 0;
    const evalModel = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => {
        evalCallCount++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decision: "approve",
                concerns: [],
                reasoning: "ok",
                confidence: 0.9,
              }),
            },
          ],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          warnings: [],
        };
      }) as never,
    }) as unknown as LanguageModel;

    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: ctrl.signal,
      pinnedConversationId: null,
      buildCompletionCheckInput: async () => {
        await Promise.resolve();
        ctrl.abort();
        return {
          conversationId: "c-abort-during-build-pill",
          turnIndex: 0,
          rejectionRound: 0,
          originalRequest: "do X",
          draftedResponse: "(filled by loop)",
          todos: [],
          // Tool call ⇒ shouldGate would return gate:true (pill path).
          toolCallTrace: [makeTrace("snapshot")],
          evaluatorModel: evalModel,
        };
      },
    });
    const chunks = await drainStream(stream);

    // No evaluator call on an aborted turn.
    expect(evalCallCount).toBe(0);
    // No "Running quality check…" pill flashed.
    const running = chunks.filter(
      (c) => (c as { type: string }).type === "data-completion-check-running",
    );
    expect(running).toHaveLength(0);
  });

  it("SDK abort chunk in the stream ⇒ no completion check, even when abortSignal flag is not yet set", async () => {
    // Reproduces the real production path. On Stop, the AI SDK aborts
    // the signal and its toUIMessageStream() emits a `{ type: "abort" }`
    // chunk then CLOSES CLEANLY (it does not throw). pipeAndObserve
    // therefore returns a populated finalText for an abandoned turn.
    // The loop must treat the abort chunk itself as the terminate
    // signal — not rely solely on the abortSignal.aborted flag, whose
    // timing relative to the gate window is unreliable.
    //
    // Here abortSignal is intentionally left UN-aborted so the test
    // proves detection comes from the chunk, not the flag.
    const agent: RejectionLoopAgent & { callCount: number } = {
      tools: {},
      get callCount() {
        return callCount;
      },
      stream: async () => {
        callCount++;
        return {
          toUIMessageStream: () =>
            new ReadableStream<UIMessageChunk>({
              start(controller) {
                const id = "m-sdk-abort";
                controller.enqueue({ type: "text-start", id } as never);
                controller.enqueue({
                  type: "text-delta",
                  id,
                  delta: "partial before stop",
                } as never);
                // The SDK's abort emission: an abort chunk, then a
                // clean close (no throw).
                controller.enqueue({ type: "abort" } as never);
                controller.close();
              },
            }),
        };
      },
    };
    let callCount = 0;

    let evalCallCount = 0;
    const evalModel = new MockLanguageModelV3({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doGenerate: (async () => {
        evalCallCount++;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decision: "approve",
                concerns: [],
                reasoning: "ok",
                confidence: 0.9,
              }),
            },
          ],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          warnings: [],
        };
      }) as never,
    }) as unknown as LanguageModel;

    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      // Flag deliberately left unset — detection must come from the chunk.
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c-sdk-abort",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        todos: [],
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: evalModel,
      }),
    });
    const chunks = await drainStream(stream);

    expect(agent.callCount).toBe(1);
    // The completion check must NOT run for an aborted turn.
    expect(evalCallCount).toBe(0);
    // The abort chunk must still be forwarded to the UI.
    const abortChunks = chunks.filter(
      (c) => (c as { type: string }).type === "abort",
    );
    expect(abortChunks).toHaveLength(1);
  });

  it("buildCompletionCheckInput returning undefined ⇒ single iteration, no loop", async () => {
    const agent = makeStubAgent(["Done."]);
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => undefined,
    });
    await drainStream(stream);
    expect(agent.callCount).toBe(1);
  });

  it("emits running enter then done (outcome=approved) for a real evaluator call", async () => {
    const agent = makeStubAgent(["The answer."]);
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c-running-1",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        todos: [],
        // Tool call ensures shouldGate returns gate:true.
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: approveModel(),
      }),
    });
    const chunks = await drainStream(stream);
    const running = chunks.filter(
      (c) => (c as { type: string }).type === "data-completion-check-running",
    ) as Array<{
      id: string;
      data: {
        id: string;
        phase: "evaluating" | "done";
        outcome?: string;
      };
    }>;
    expect(running).toHaveLength(2);
    // Both chunks share the same chunk-level id and data.id (the SDK
    // overwrite-by-id semantics rely on this).
    expect(running[0].id).toBe(running[1].id);
    expect(running[0].data.id).toBe(running[1].data.id);
    expect(running[0].data.phase).toBe("evaluating");
    expect(running[0].data.outcome).toBeUndefined();
    expect(running[1].data.phase).toBe("done");
    expect(running[1].data.outcome).toBe("approved");
  });

  it("does NOT emit running chunks when the gate would skip (no tool calls + no todos)", async () => {
    const agent = makeStubAgent(["Hello!"]);
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("hi")],
      sendMessagesAtCall: [userMessage("hi")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c-skip",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "hi",
        draftedResponse: "(filled by loop)",
        // Trigger heuristic skips this: no todos AND no tool calls.
        todos: [],
        toolCallTrace: [],
        evaluatorModel: approveModel(),
      }),
    });
    const chunks = await drainStream(stream);
    const running = chunks.filter(
      (c) => (c as { type: string }).type === "data-completion-check-running",
    );
    expect(running).toHaveLength(0);
  });

  it("multi-round rejection loop emits a paired enter/done per evaluator call", async () => {
    // reject → approve sequence runs the evaluator twice → 2 paired
    // running chunks, each with its own id.
    const agent = makeStubAgent(["First.", "Second."]);
    const evalModel = rejectThenApproveModel();
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c-multi",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        todos: [],
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: evalModel,
      }),
    });
    const chunks = await drainStream(stream);
    const running = chunks.filter(
      (c) => (c as { type: string }).type === "data-completion-check-running",
    ) as Array<{
      id: string;
      data: { id: string; phase: string; outcome?: string };
    }>;
    expect(running).toHaveLength(4);
    // Round 1: enter + done(rejected)
    expect(running[0].data.phase).toBe("evaluating");
    expect(running[1].data.phase).toBe("done");
    expect(running[1].data.outcome).toBe("rejected");
    // Round 2: enter + done(approved). Distinct id from round 1.
    expect(running[2].data.phase).toBe("evaluating");
    expect(running[3].data.phase).toBe("done");
    expect(running[3].data.outcome).toBe("approved");
    expect(running[0].id).not.toBe(running[2].id);
    // Pairs share their id.
    expect(running[0].id).toBe(running[1].id);
    expect(running[2].id).toBe(running[3].id);
  });

  it("force-emit (max rounds exceeded) reports outcome=force-emitted on done", async () => {
    const agent = makeStubAgent(
      Array.from({ length: MAX_REJECTION_ROUNDS + 1 }, (_, k) => `Bad ${k}.`),
    );
    const evalModel = alwaysRejectModel();
    const stream = runWithRejectionLoop({
      agent,
      validatedMessages: [userMessage("do X")],
      sendMessagesAtCall: [userMessage("do X")],
      abortSignal: undefined,
      pinnedConversationId: null,
      buildCompletionCheckInput: () => ({
        conversationId: "c-fe",
        turnIndex: 0,
        rejectionRound: 0,
        originalRequest: "do X",
        draftedResponse: "(filled by loop)",
        todos: [],
        toolCallTrace: [makeTrace("snapshot")],
        evaluatorModel: evalModel,
      }),
    });
    const chunks = await drainStream(stream);
    const running = chunks.filter(
      (c) => (c as { type: string }).type === "data-completion-check-running",
    ) as Array<{ data: { phase: string; outcome?: string } }>;
    // The final round's done chunk should report force-emitted.
    const lastDone = [...running]
      .reverse()
      .find((c) => c.data.phase === "done");
    expect(lastDone?.data.outcome).toBe("force-emitted");
  });
});

describe("emitCompletionCheckRunningChunk", () => {
  it("uses data.id as the chunk id so the SDK overwrites in place", () => {
    const enqueued: unknown[] = [];
    const fakeController = {
      enqueue: (c: unknown) => enqueued.push(c),
    } as unknown as ReadableStreamDefaultController<UIMessageChunk>;
    emitCompletionCheckRunningChunk(fakeController, {
      id: "abc-123",
      phase: "evaluating",
    });
    expect(enqueued).toHaveLength(1);
    const chunk = enqueued[0] as { type: string; id: string; data: unknown };
    expect(chunk.type).toBe("data-completion-check-running");
    expect(chunk.id).toBe("abc-123");
    expect(chunk.data).toEqual({ id: "abc-123", phase: "evaluating" });
  });

  it("threads outcome through on done chunks", () => {
    const enqueued: unknown[] = [];
    const fakeController = {
      enqueue: (c: unknown) => enqueued.push(c),
    } as unknown as ReadableStreamDefaultController<UIMessageChunk>;
    emitCompletionCheckRunningChunk(fakeController, {
      id: "abc-123",
      phase: "done",
      outcome: "approved",
    });
    const chunk = enqueued[0] as { data: { outcome?: string } };
    expect(chunk.data.outcome).toBe("approved");
  });
});
