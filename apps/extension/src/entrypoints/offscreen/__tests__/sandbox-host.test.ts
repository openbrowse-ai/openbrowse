import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The offscreen `SANDBOX_EXECUTE` handler is the offscreen-side
 * counterpart to the SW dispatch in `tools/sandbox.ts`. Its job is to
 * accept the payload and run `executeInSandboxLocal` against the
 * offscreen document's iframe.
 *
 * We stub the iframe via fake `document`/`window` globals, asserting
 * that the handler:
 *   - validates payload shape
 *   - threads `code`, `input`, `options` into the local executor
 *   - resolves with a `ExecuteCodeResult` (never throws)
 *
 * The handler (and the `tools/sandbox.ts` module it uses internally)
 * caches an iframe in module scope. To make sure tests are independent
 * — in particular so the "No document" branch is exercised even if a
 * prior test populated the cache — we `vi.resetModules()` + dynamic
 * import `handleSandboxExecute`/`isSandboxExecutePayload` inside each
 * test.
 */

describe("offscreen SANDBOX_EXECUTE handler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("isSandboxExecutePayload", () => {
    it("accepts a well-formed payload", async () => {
      const { isSandboxExecutePayload } = await import("../sandbox-host");
      expect(
        isSandboxExecutePayload({
          target: "offscreen",
          type: "SANDBOX_EXECUTE",
          code: "return 1",
        }),
      ).toBe(true);
    });

    it("rejects payloads with the wrong target", async () => {
      const { isSandboxExecutePayload } = await import("../sandbox-host");
      expect(
        isSandboxExecutePayload({
          target: "renderer",
          type: "SANDBOX_EXECUTE",
          code: "return 1",
        }),
      ).toBe(false);
    });

    it("rejects payloads with the wrong type", async () => {
      const { isSandboxExecutePayload } = await import("../sandbox-host");
      expect(
        isSandboxExecutePayload({
          target: "offscreen",
          type: "PYTHON_EXECUTE",
          code: "return 1",
        }),
      ).toBe(false);
    });

    it("rejects payloads missing code", async () => {
      const { isSandboxExecutePayload } = await import("../sandbox-host");
      expect(
        isSandboxExecutePayload({
          target: "offscreen",
          type: "SANDBOX_EXECUTE",
        }),
      ).toBe(false);
    });

    it("rejects non-object inputs", async () => {
      const { isSandboxExecutePayload } = await import("../sandbox-host");
      expect(isSandboxExecutePayload(null)).toBe(false);
      expect(isSandboxExecutePayload("SANDBOX_EXECUTE")).toBe(false);
    });
  });

  it("executes against the local iframe and returns its result", async () => {
    const fakeIframe = {
      contentWindow: { postMessage: vi.fn() },
      style: {} as Record<string, string>,
      getAttribute: vi.fn().mockReturnValue("1"),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      parentNode: {},
    };
    vi.stubGlobal("document", {
      URL: "chrome-extension://test/offscreen.html",
      createElement: vi.fn().mockReturnValue(fakeIframe),
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn((evt: string, h: (e: MessageEvent) => void) => {
        if (evt !== "message") return;
        queueMicrotask(() => {
          h({
            data: { id: 1, result: "from-sandbox", logs: ["log line"] },
          } as MessageEvent);
        });
      }),
      removeEventListener: vi.fn(),
    });

    const { handleSandboxExecute } = await import("../sandbox-host");
    const res = await handleSandboxExecute({
      target: "offscreen",
      type: "SANDBOX_EXECUTE",
      code: "return 'x'",
      input: { a: 1 },
      options: { unboundedOutput: true, timeoutMs: 5000 },
    });

    expect(res.result).toBe("from-sandbox");
    expect(res.logs).toEqual(["log line"]);
  });

  it("encodes thrown errors into ExecuteCodeResult.error", async () => {
    // No document → `executeInSandboxLocal` throws when reaching for it.
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);

    const { handleSandboxExecute } = await import("../sandbox-host");
    const res = await handleSandboxExecute({
      target: "offscreen",
      type: "SANDBOX_EXECUTE",
      code: "return 1",
    });
    expect(res.error).toBeDefined();
    expect(res.logs).toEqual([]);
  });
});
