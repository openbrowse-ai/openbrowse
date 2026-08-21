/**
 * Guard tests for the model-facing output projection in `toSDKTool`.
 *
 * The AI SDK sends a tool's `execute` return value to the model verbatim
 * unless the tool declares a `toModelOutput`. `delegate` returns a
 * `SubagentRunResult` whose `transcript` field carries EVERY assistant
 * message of the subagent run — each with the full input and output of every
 * tool it called (DOM snapshots, page text, base64 screenshots). Shipping
 * that to the parent's model defeats the entire point of delegating
 * (summary-only, fresh context) and is unrecoverable afterwards: every
 * compaction pruner keys on the top-level `part.toolName`, so payload nested
 * inside another tool's output is structurally invisible to them.
 *
 * These tests lock in that the projection exists, drops exactly the UI-only
 * field, and leaves every other tool's model output alone.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toSDKTool } from "../agent-transport";
import type { SubagentRunResult } from "../subagents/types";
import type { BrowserTool } from "../types";

type ModelOutputFn = (arg: { output: unknown }) => unknown;

/** Read the SDK-facing `toModelOutput` off a wrapped tool, if it has one. */
function modelOutputOf(tool: unknown): ModelOutputFn | undefined {
  return (tool as { toModelOutput?: ModelOutputFn }).toModelOutput;
}

/** Minimal BrowserTool stub; only the wrapper's name-keyed behavior matters. */
function stubTool(name: string): BrowserTool<Record<string, never>, unknown> {
  return {
    name,
    description: `stub ${name}`,
    parameters: z.object({}),
    execute: async () => ({}),
  };
}

describe("toSDKTool — delegate output projection", () => {
  it("strips `transcript` from what the model sees", () => {
    const wrapped = toSDKTool(stubTool("delegate"), "delegate");
    const toModelOutput = modelOutputOf(wrapped);
    expect(toModelOutput).toBeTypeOf("function");

    // A realistic result: the transcript is the bulk of the payload.
    const output: SubagentRunResult = {
      finalText: "Found 3 pricing tiers: Free, Pro, Enterprise.",
      childConversationId: "subagent-abc-123",
      status: "completed",
      transcript: [
        {
          id: "m1",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "screenshot",
              toolCallId: "c1",
              state: "output-available",
              input: {},
              output: {
                imageDataUrl: `data:image/png;base64,${"A".repeat(50_000)}`,
              },
            },
          ],
        },
      ],
    };

    const projected = toModelOutput!({ output }) as {
      type: string;
      value: Record<string, unknown>;
    };

    expect(projected.type).toBe("json");
    expect(projected.value).not.toHaveProperty("transcript");
    // Everything the parent's loop actually needs survives.
    expect(projected.value).toEqual({
      finalText: "Found 3 pricing tiers: Free, Pro, Enterprise.",
      childConversationId: "subagent-abc-123",
      status: "completed",
    });
    // And the projection is genuinely small — the whole point.
    expect(JSON.stringify(projected.value).length).toBeLessThan(200);
  });

  it("does not mutate the original output (the UI still renders the trace)", () => {
    const wrapped = toSDKTool(stubTool("delegate"), "delegate");
    const output: SubagentRunResult = {
      finalText: "done",
      childConversationId: "c1",
      status: "completed",
      transcript: [{ id: "m1", parts: [{ type: "text", text: "hello" }] }],
    };

    modelOutputOf(wrapped)!({ output });

    expect(output.transcript).toHaveLength(1);
  });

  it("passes through an output that has no transcript", () => {
    const wrapped = toSDKTool(stubTool("delegate"), "delegate");
    const output: SubagentRunResult = {
      finalText: "Subagent 'explore' could not run: unknown agent",
      childConversationId: null,
      status: "failed",
      errorMessage: "unknown agent",
    };

    const projected = modelOutputOf(wrapped)!({ output }) as {
      value: unknown;
    };
    // Same object identity — the no-op path must not allocate.
    expect(projected.value).toBe(output);
  });

  it("tolerates a non-object output", () => {
    const wrapped = toSDKTool(stubTool("delegate"), "delegate");
    const fn = modelOutputOf(wrapped)!;
    expect((fn({ output: "plain string" }) as { value: unknown }).value).toBe(
      "plain string",
    );
    expect((fn({ output: null }) as { value: unknown }).value).toBe(null);
    expect((fn({ output: [1, 2] }) as { value: unknown }).value).toEqual([
      1, 2,
    ]);
  });
});

describe("toSDKTool — projection scope", () => {
  it("leaves ordinary tools without a toModelOutput", () => {
    for (const name of [
      "snapshot",
      "readPage",
      "navigate",
      "batch",
      "extract",
    ]) {
      expect(modelOutputOf(toSDKTool(stubTool(name), name))).toBeUndefined();
    }
  });

  it("still gives `screenshot` the image-content adapter", () => {
    // Regression guard: the delegate branch must not shadow the image branch.
    const wrapped = toSDKTool(stubTool("screenshot"), "screenshot");
    const projected = modelOutputOf(wrapped)!({
      output: { imageDataUrl: "data:image/png;base64,QUJD" },
    });
    expect(projected).toEqual({
      type: "content",
      value: [{ type: "image-data", data: "QUJD", mediaType: "image/png" }],
    });
  });

  it("does not resolve a projection from Object.prototype", () => {
    // The registry is a Map precisely so a tool named `constructor` /
    // `toString` can't inherit one.
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      expect(modelOutputOf(toSDKTool(stubTool(name), name))).toBeUndefined();
    }
  });
});
