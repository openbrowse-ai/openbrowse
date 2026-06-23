import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeCodeTool } from "../execute-code";
import * as sandbox from "../sandbox";
import type { ToolContext } from "../../driver";

// Tests for the executeCode tool's parameter plumbing — specifically:
//   (1) timeout_ms is passed through to executeInSandbox as `timeoutMs`.
//   (2) timeout_ms above the Zod cap (120000) is rejected at parse time.
//   (3) When timeout_ms is omitted, executeInSandbox is called WITHOUT
//       a timeoutMs option, so its own default (30 s) applies.
//
// The actual AsyncFunction wrapping + sandbox-side timeout enforcement
// lives in apps/extension/public/sandbox.html, which loads only in a real
// browser context (chrome.runtime.getURL + iframe). We exercise the
// tool/sandbox.ts boundary here; an integration test against the real
// iframe would require a Playwright harness and isn't worth the cost
// for what's a small string-passthrough.

vi.mock("../sandbox", () => ({
  executeInSandbox: vi.fn(),
}));

function makeCtx(conversationId: string | null = null): ToolContext {
  return {
    driver: {} as ToolContext["driver"],
    session: { conversationId, spaceId: null },
  };
}

describe("executeCode timeout_ms parameter", () => {
  beforeEach(() => {
    vi.mocked(sandbox.executeInSandbox).mockReset();
    vi.mocked(sandbox.executeInSandbox).mockResolvedValue({
      result: "ok",
      logs: [],
    });
  });

  it("passes timeout_ms through to executeInSandbox as timeoutMs", async () => {
    await executeCodeTool.execute(
      { code: "return 1;", timeout_ms: 60_000 },
      makeCtx(),
    );
    expect(sandbox.executeInSandbox).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(sandbox.executeInSandbox).mock.calls[0][2];
    expect(opts).toMatchObject({ timeoutMs: 60_000 });
  });

  it("omits timeoutMs when timeout_ms is unset (sandbox uses its default)", async () => {
    await executeCodeTool.execute({ code: "return 1;" }, makeCtx());
    const opts = vi.mocked(sandbox.executeInSandbox).mock.calls[0][2];
    // unboundedOutput is always present (false here); timeoutMs must NOT
    // be set so the sandbox falls back to its own DEFAULT_TIMEOUT_MS.
    expect(opts).toEqual({ unboundedOutput: false });
  });

  it("Zod schema rejects timeout_ms above 120000", () => {
    const result = executeCodeTool.parameters.safeParse({
      code: "return 1;",
      timeout_ms: 999_999,
    });
    expect(result.success).toBe(false);
  });

  it("Zod schema rejects non-positive timeout_ms", () => {
    expect(
      executeCodeTool.parameters.safeParse({
        code: "return 1;",
        timeout_ms: 0,
      }).success,
    ).toBe(false);
    expect(
      executeCodeTool.parameters.safeParse({
        code: "return 1;",
        timeout_ms: -100,
      }).success,
    ).toBe(false);
  });

  it("Zod schema accepts timeout_ms at the boundary (120000)", () => {
    expect(
      executeCodeTool.parameters.safeParse({
        code: "return 1;",
        timeout_ms: 120_000,
      }).success,
    ).toBe(true);
  });
});

// Lightweight assertion that the AsyncFunction wrapper assumption holds.
// We don't load sandbox.html here — that needs a browser — but we DO
// verify the same constructor pattern the sandbox uses parses + runs.
// This catches regressions in environments where AsyncFunction isn't
// reachable via `(async () => {}).constructor` (theoretically possible
// in some shims but never in V8 / SpiderMonkey / JavaScriptCore).
describe("AsyncFunction wrapper assumption (mirror of sandbox.html)", () => {
  it("can build an async function with top-level await via the constructor", async () => {
    const AsyncFunction = (async () => {}).constructor as new (
      ...args: string[]
    ) => (input: unknown) => Promise<unknown>;
    const fn = new AsyncFunction(
      "__input",
      "const r = await Promise.resolve(__input + 1); return r;",
    );
    const result = await fn(41);
    expect(result).toBe(42);
  });

  it("propagates body errors as rejected promises", async () => {
    const AsyncFunction = (async () => {}).constructor as new (
      ...args: string[]
    ) => (input: unknown) => Promise<unknown>;
    const fn = new AsyncFunction("__input", "throw new Error('boom');");
    await expect(fn(undefined)).rejects.toThrow("boom");
  });
});
