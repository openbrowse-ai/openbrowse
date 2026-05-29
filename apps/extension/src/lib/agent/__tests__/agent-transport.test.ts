/**
 * Tests for the `toSDKTool` wrapper in agent-transport.ts.
 *
 * Focus is on the abortSignal-propagation contract added so that
 * clicking Stop while a subagent is running actually cancels the
 * subagent. The SDK passes `options.abortSignal` to every tool's
 * execute(); the wrapper must stamp it onto `ctx.signal` so tools
 * (most importantly `delegate`) can forward it downstream.
 *
 * Other wrapper concerns (approval gating, tab resolution, image
 * outputs) are exercised via integration paths; this file scopes
 * itself to the signal plumbing.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toSDKTool } from "../agent-transport";
import type { BrowserTool } from "../types";
import type { ToolContext } from "../driver";

function makeMinimalContext(): ToolContext {
  return {
    // Driver is unused in these tests — the wrapper only touches it via
    // the inner tool's execute, which we replace with a recorder.
    driver: {} as ToolContext["driver"],
    session: { conversationId: null },
  };
}

function makeRecordingTool(): {
  tool: BrowserTool<{ x: string }, { ok: boolean }>;
  received: { ctx: ToolContext | null };
} {
  const received: { ctx: ToolContext | null } = { ctx: null };
  const tool: BrowserTool<{ x: string }, { ok: boolean }> = {
    name: "recordingTool",
    description: "Records the ctx it receives",
    parameters: z.object({ x: z.string() }),
    execute: async (_input, ctx) => {
      received.ctx = ctx;
      return { ok: true };
    },
  };
  return { tool, received };
}

describe("toSDKTool — abortSignal propagation", () => {
  it("forwards options.abortSignal to ctx.signal so delegate can cancel", async () => {
    const { tool, received } = makeRecordingTool();
    const wrapped = toSDKTool(tool, "recordingTool");

    const controller = new AbortController();
    const baseCtx = makeMinimalContext();

    // Invoke as the AI SDK would: shaped options object with the
    // per-call abortSignal.
    await (
      wrapped.execute as unknown as (
        input: { x: string },
        options: {
          toolCallId: string;
          experimental_context?: unknown;
          abortSignal?: AbortSignal;
        },
      ) => Promise<unknown>
    )(
      { x: "hello" },
      {
        toolCallId: "tc_1",
        abortSignal: controller.signal,
        experimental_context: baseCtx,
      },
    );

    expect(received.ctx).not.toBeNull();
    expect(received.ctx?.signal).toBe(controller.signal);
    expect(received.ctx?.toolCallId).toBe("tc_1");
  });

  it("propagates abort through the same signal reference (not a snapshot)", async () => {
    const { tool, received } = makeRecordingTool();
    const wrapped = toSDKTool(tool, "recordingTool");

    const controller = new AbortController();
    const baseCtx = makeMinimalContext();

    await (
      wrapped.execute as unknown as (
        input: { x: string },
        options: {
          toolCallId: string;
          experimental_context?: unknown;
          abortSignal?: AbortSignal;
        },
      ) => Promise<unknown>
    )(
      { x: "hello" },
      {
        toolCallId: "tc_2",
        abortSignal: controller.signal,
        experimental_context: baseCtx,
      },
    );

    // Mutate the controller AFTER execute resolved; the captured signal
    // should reflect the change because the wrapper passes the live
    // reference, not a copy.
    expect(received.ctx?.signal?.aborted).toBe(false);
    controller.abort();
    expect(received.ctx?.signal?.aborted).toBe(true);
  });

  it("leaves ctx.signal undefined when the SDK does not provide one", async () => {
    const { tool, received } = makeRecordingTool();
    const wrapped = toSDKTool(tool, "recordingTool");

    const baseCtx = makeMinimalContext();

    await (
      wrapped.execute as unknown as (
        input: { x: string },
        options: {
          toolCallId: string;
          experimental_context?: unknown;
          abortSignal?: AbortSignal;
        },
      ) => Promise<unknown>
    )(
      { x: "hello" },
      {
        toolCallId: "tc_3",
        experimental_context: baseCtx,
      },
    );

    expect(received.ctx?.signal).toBeUndefined();
  });
});
