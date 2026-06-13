import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `executePython` must resolve the conversation id from the per-call
 * `ToolContext` (`ctx.session.conversationId`), not from a build-time
 * closure. This is what makes it work for:
 *
 *   - A brand-new chat whose transport was built before the conversation
 *     row existed (the transport's tools would otherwise be bound to a
 *     stale `null`).
 *   - A subagent, which reuses the PARENT's tool instances but is handed
 *     the CHILD's ToolContext via `experimental_context` — the workspace
 *     must be the child's, not the parent's.
 */

const rpc = vi.hoisted(() => ({
  executePythonRPC: vi.fn(
    async (_args: { conversationId: string }) => ({
      ok: true,
      result: undefined,
      stdout: "",
      stderr: "",
      timings: { runMs: 1 },
    }),
  ),
  warmupPythonRPC: vi.fn(async () => undefined),
}));

vi.mock("@/lib/python/messages", () => ({
  executePythonRPC: rpc.executePythonRPC,
  warmupPythonRPC: rpc.warmupPythonRPC,
}));

vi.mock("@/lib/vfs/events", () => ({
  emitVfsChange: vi.fn(),
}));

import { createPythonTool } from "../execute-python";
import type { ToolContext } from "../../driver/tool-context";

function ctxWith(conversationId: string | null): ToolContext {
  return {
    // The driver is unused on the python path; a bare cast keeps the
    // fixture minimal.
    driver: {} as ToolContext["driver"],
    session: { conversationId },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("executePython — conversation id resolution", () => {
  it("uses the call-time ctx.session.conversationId", async () => {
    const tool = createPythonTool();
    const res = await tool.execute({ code: "1" }, ctxWith("conv-A"));

    expect(res.ok).toBe(true);
    expect(rpc.executePythonRPC).toHaveBeenCalledTimes(1);
    expect(rpc.executePythonRPC.mock.calls[0][0]).toMatchObject({
      conversationId: "conv-A",
    });
  });

  it("targets the CHILD conversation when run as a subagent", async () => {
    // Subagents reuse the parent's tool instance but inject the child ctx.
    const tool = createPythonTool();
    await tool.execute({ code: "1" }, ctxWith("child-conv"));

    expect(rpc.executePythonRPC.mock.calls[0][0]).toMatchObject({
      conversationId: "child-conv",
    });
  });

  it("errors (and does not call the RPC) when there is no conversation", async () => {
    const tool = createPythonTool();
    const res = await tool.execute({ code: "1" }, ctxWith(null));

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No conversation context/i);
    expect(rpc.executePythonRPC).not.toHaveBeenCalled();
  });

  it("errors when ctx.session is absent entirely", async () => {
    const tool = createPythonTool();
    const res = await tool.execute(
      { code: "1" },
      { driver: {} as ToolContext["driver"] },
    );

    expect(res.ok).toBe(false);
    expect(rpc.executePythonRPC).not.toHaveBeenCalled();
  });
});
