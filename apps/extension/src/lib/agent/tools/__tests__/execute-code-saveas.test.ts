import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sandbox = vi.hoisted(() => ({
  executeInSandbox: vi.fn<
    (
      code: string,
      input?: unknown,
      options?: { unboundedOutput?: boolean },
    ) => Promise<{
      result?: unknown;
      logs: string[];
      error?: string;
    }>
  >(async () => ({ logs: [] })),
}));

const opfs = vi.hoisted(() => ({
  writeFileAtomic: vi.fn(async (_p: string, _c: string) => undefined),
  writeFileBytesAtomic: vi.fn(
    async (_p: string, _c: Blob | ArrayBuffer | Uint8Array) => undefined,
  ),
}));

vi.mock("../sandbox", () => ({
  executeInSandbox: sandbox.executeInSandbox,
}));

vi.mock("@/lib/vfs/opfs", () => ({
  OPFS: opfs,
}));

vi.mock("@/lib/uploads-dir", () => ({
  isUploadsPath: (p: string) => p.startsWith(".uploads/") || p.includes("/.uploads/"),
}));

import { executeCodeTool } from "../execute-code";
import type { ToolContext } from "../../driver/tool-context";

function ctxWith(conversationId: string | null): ToolContext {
  return {
    driver: {} as ToolContext["driver"],
    session: { conversationId, spaceId: null },
  };
}

beforeEach(() => {
  sandbox.executeInSandbox.mockReset();
  opfs.writeFileAtomic.mockReset();
  opfs.writeFileBytesAtomic.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("executeCode (no saveAs) — unchanged behavior", () => {
  it("returns the script result directly", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: { hello: "world" },
      logs: [],
    });
    const r = await executeCodeTool.execute(
      { code: "return { hello: 'world' };" },
      ctxWith("conv-1"),
    );
    expect(r.result).toEqual({ hello: "world" });
    expect(r.path).toBeUndefined();
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });

  it("propagates sandbox errors without writing", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      logs: [],
      error: "boom",
    });
    const r = await executeCodeTool.execute(
      { code: "throw new Error('boom')", saveAs: "x.txt" },
      ctxWith("conv-1"),
    );
    expect(r.error).toBe("boom");
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });
});

describe("executeCode with saveAs", () => {
  it("passes unboundedOutput: true to the sandbox when saveAs is set", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: "x",
      logs: [],
    });
    await executeCodeTool.execute(
      { code: "return 'x'", saveAs: "x.txt" },
      ctxWith("conv-A"),
    );
    // Last arg is the options bag; saveAs => unboundedOutput: true so the
    // sandbox skips the 1MB JSON-output cap that protects chat context.
    const call = sandbox.executeInSandbox.mock.calls[0];
    expect(call[2]).toEqual({ unboundedOutput: true });
  });

  it("passes unboundedOutput: false when saveAs is NOT set", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: "x",
      logs: [],
    });
    await executeCodeTool.execute({ code: "return 'x'" }, ctxWith("conv-A"));
    const call = sandbox.executeInSandbox.mock.calls[0];
    expect(call[2]).toEqual({ unboundedOutput: false });
  });

  it("writes a string return value to /workspace and omits it from result", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: '{"k":"v"}',
      logs: ["info"],
    });
    const r = await executeCodeTool.execute(
      { code: "return JSON.stringify({k:'v'})", saveAs: "out.json" },
      ctxWith("conv-A"),
    );
    expect(r.result).toBeUndefined();
    expect(r.path).toBe("out.json");
    expect(r.bytes).toBe(9);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.logs).toEqual(["info"]);
    expect(opfs.writeFileAtomic).toHaveBeenCalledWith(
      "conversations/conv-A/workspace/out.json",
      '{"k":"v"}',
    );
  });

  it("decodes a base64 binary envelope", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: { __binary_b64: "aGVsbG8=" },
      logs: [],
    });
    const r = await executeCodeTool.execute(
      { code: "return { __binary_b64: btoa('hello') }", saveAs: "blob.bin" },
      ctxWith("conv-A"),
    );
    expect(r.path).toBe("blob.bin");
    expect(r.bytes).toBe(5);
    expect(opfs.writeFileBytesAtomic).toHaveBeenCalledTimes(1);
  });

  it("auto-stringifies object return values into pretty JSON", async () => {
    // Previously: rejected non-string/non-binary returns, forcing the
    // agent to JSON.stringify inside the script body. Now: any JSON-able
    // value is auto-serialized so the common paginated-scrape pattern
    // (`return { count, entries }`) works without re-running on failure.
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: { not: "a string" },
      logs: [],
    });
    const r = await executeCodeTool.execute(
      { code: "return { not: 'a string' }", saveAs: "x.json" },
      ctxWith("conv-A"),
    );
    expect(r.error).toBeUndefined();
    expect(r.path).toBe("x.json");
    expect(opfs.writeFileAtomic).toHaveBeenCalledWith(
      "conversations/conv-A/workspace/x.json",
      '{\n  "not": "a string"\n}',
    );
  });

  it("still rejects truly non-JSONable returns (function, undefined)", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: undefined,
      logs: [],
    });
    const r = await executeCodeTool.execute(
      { code: "return undefined", saveAs: "x.txt" },
      ctxWith("conv-A"),
    );
    expect(r.error).toMatch(/not representable in JSON|must be a string/);
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });

  it("rejects when no conversation is bound", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: "x",
      logs: [],
    });
    const r = await executeCodeTool.execute(
      { code: "return 'x'", saveAs: "x.txt" },
      ctxWith(null),
    );
    expect(r.error).toMatch(/active conversation/);
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });

  it("rejects path traversal", async () => {
    sandbox.executeInSandbox.mockResolvedValueOnce({
      result: "x",
      logs: [],
    });
    const r = await executeCodeTool.execute(
      { code: "return 'x'", saveAs: "../escape.txt" },
      ctxWith("conv-A"),
    );
    expect(r.error).toBeDefined();
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });
});
