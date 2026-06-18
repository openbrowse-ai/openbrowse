import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opfs = vi.hoisted(() => ({
  writeFileAtomic: vi.fn(async (_p: string, _c: string) => undefined),
  writeFileBytesAtomic: vi.fn(
    async (_p: string, _c: Blob | ArrayBuffer | Uint8Array) => undefined,
  ),
}));

vi.mock("@/lib/vfs/opfs", () => ({
  OPFS: opfs,
}));

vi.mock("@/lib/uploads-dir", () => ({
  isUploadsPath: (p: string) => p.startsWith(".uploads/") || p.includes("/.uploads/"),
}));

vi.mock("../../driver", () => ({
  resolveTabOrThrow: vi.fn(async (_ctx: unknown, handle: string) => ({
    id: 42,
    handle,
  })),
}));

vi.mock("../../ref-store", () => ({
  invalidateRefs: vi.fn(),
}));

import { executeOnPageTool } from "../execute-on-page";
import type { ToolContext } from "../../driver/tool-context";

function ctxWith(conversationId: string | null) {
  return {
    driver: {
      sendCommand: vi.fn(async (_id: number, _method: string, _params: unknown) => ({
        result: { type: "string", value: '{"k":"v"}' },
      })),
      getTab: vi.fn(),
    } as unknown as ToolContext["driver"],
    session: { conversationId },
  } as ToolContext;
}

beforeEach(() => {
  opfs.writeFileAtomic.mockReset();
  opfs.writeFileBytesAtomic.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("executeOnPage with saveAs", () => {
  it("writes string return value and omits it from the result", async () => {
    const ctx = ctxWith("conv-A");
    const r = await executeOnPageTool.execute(
      { tab: "t1", code: "return JSON.stringify({k:'v'})", saveAs: "data.json" },
      ctx,
    );
    expect(r.result).toBeUndefined();
    expect(r.path).toBe("data.json");
    expect(r.bytes).toBe(9);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(opfs.writeFileAtomic).toHaveBeenCalledWith(
      "conversations/conv-A/workspace/data.json",
      '{"k":"v"}',
    );
  });

  it("rejects when no conversation is bound", async () => {
    const ctx = ctxWith(null);
    const r = await executeOnPageTool.execute(
      { tab: "t1", code: "return 'x'", saveAs: "x.txt" },
      ctx,
    );
    expect(r.error).toMatch(/active conversation/);
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });

  it("rejects path traversal", async () => {
    const ctx = ctxWith("conv-A");
    const r = await executeOnPageTool.execute(
      { tab: "t1", code: "return 'x'", saveAs: "../escape.txt" },
      ctx,
    );
    expect(r.error).toBeDefined();
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });

  it("auto-stringifies object return values into pretty JSON", async () => {
    // Previously rejected; now flows through persistReturnValue's JSON
    // branch so paginated scrapes that `return { count, entries }`
    // succeed without the agent having to remember to JSON.stringify.
    const ctx = ctxWith("conv-A");
    (ctx.driver.sendCommand as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: { type: "object", value: { not: "a string" } },
    });
    const r = await executeOnPageTool.execute(
      { tab: "t1", code: "return { not: 'a string' }", saveAs: "x.json" },
      ctx,
    );
    expect(r.error).toBeUndefined();
    expect(r.path).toBe("x.json");
    expect(opfs.writeFileAtomic).toHaveBeenCalledWith(
      "conversations/conv-A/workspace/x.json",
      '{\n  "not": "a string"\n}',
    );
  });

  it("preserves original behavior without saveAs", async () => {
    const ctx = ctxWith("conv-A");
    (ctx.driver.sendCommand as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      result: { type: "string", value: '{"k":"v"}' },
    });
    const r = await executeOnPageTool.execute(
      { tab: "t1", code: "return JSON.stringify({k:'v'})" },
      ctx,
    );
    expect(r.result).toBe('{"k":"v"}');
    expect(r.path).toBeUndefined();
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });

  it("propagates page exceptions before any write", async () => {
    const ctx = ctxWith("conv-A");
    (ctx.driver.sendCommand as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exceptionDetails: { exception: { description: "ReferenceError: x is not defined" } },
    });
    const r = await executeOnPageTool.execute(
      { tab: "t1", code: "x", saveAs: "out.json" },
      ctx,
    );
    expect(r.error).toMatch(/ReferenceError/);
    expect(opfs.writeFileAtomic).not.toHaveBeenCalled();
  });
});
