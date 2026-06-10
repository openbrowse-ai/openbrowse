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
  received: { ctx: ToolContext | null; resolve?: () => void };
} {
  const received: { ctx: ToolContext | null; resolve?: () => void } = { ctx: null };
  const tool: BrowserTool<{ x: string }, { ok: boolean }> = {
    name: "recordingTool",
    description: "Records the ctx it receives",
    parameters: z.object({ x: z.string() }),
    execute: async (_input, ctx) => {
      received.ctx = ctx;
      await new Promise<void>(r => { received.resolve = r; });
      return { ok: true };
    },
  };
  return { tool, received };
}

describe("toSDKTool — abortSignal propagation", () => {
  it("forwards a linked abortSignal to ctx.signal so delegate can cancel", async () => {
    const { tool, received } = makeRecordingTool();
    const wrapped = toSDKTool(tool, "recordingTool");

    const controller = new AbortController();
    const baseCtx = makeMinimalContext();

    const executePromise = (
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

    // wait for tool to receive execution
    await new Promise(r => setTimeout(r, 0));

    expect(received.ctx?.signal).toBeDefined();
    expect(received.ctx?.signal?.aborted).toBe(false);
    expect(received.ctx?.toolCallId).toBe("tc_1");
    
    // Test that the linked signal aborts when the parent aborts
    controller.abort();
    expect(received.ctx?.signal?.aborted).toBe(true);
    
    received.resolve?.();
    await executePromise;
  });

  it("provides its own ctx.signal even when the SDK does not provide one (so UI can still cancel)", async () => {
    const { tool, received } = makeRecordingTool();
    const wrapped = toSDKTool(tool, "recordingTool");

    const baseCtx = makeMinimalContext();

    const executePromise = (
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

    // wait for tool to receive execution
    await new Promise(r => setTimeout(r, 0));

    expect(received.ctx?.signal).toBeDefined();
    
    received.resolve?.();
    await executePromise;
  });
});
