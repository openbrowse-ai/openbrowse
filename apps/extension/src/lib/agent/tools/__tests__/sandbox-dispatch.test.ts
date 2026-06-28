import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `executeInSandbox` must:
 *
 *  1. Preserve its public signature
 *     `(code: string, input?, options?) → Promise<ExecuteCodeResult>`,
 *     because every tool and test mocks it at this boundary.
 *
 *  2. In the SW realm (no DOM), dispatch the call to the offscreen
 *     document via `chrome.runtime.sendMessage` with
 *     `target: "offscreen", type: "SANDBOX_EXECUTE"`. Must first
 *     `ensureOffscreenDocument()`.
 *
 *  3. In the offscreen realm, run locally against the iframe sandbox.
 *
 *  4. Empty `code` short-circuits to an error, regardless of realm.
 */

describe("executeInSandbox dispatch shim", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetModules();
  });

  it("returns a no-code error synchronously without any IPC", async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage, getURL: (p: string) => p },
    });
    const { executeInSandbox } = await import("../sandbox");
    const res = await executeInSandbox("");
    expect(res.error).toBe("No code provided");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("in SW context dispatches via runtime sendMessage to offscreen", async () => {
    // Simulate SW: no document, no window, ServiceWorkerGlobalScope present.
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());

    const sendMessage = vi.fn().mockResolvedValue({
      result: 42,
      logs: ["from offscreen"],
    });
    const createDocument = vi.fn().mockResolvedValue(undefined);
    const getContexts = vi.fn().mockResolvedValue([]);
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        getURL: (p: string) => p,
        getContexts,
      },
      offscreen: { createDocument },
    });

    const { executeInSandbox } = await import("../sandbox");
    const res = await executeInSandbox("return 1+1", { x: 1 }, {
      timeoutMs: 5000,
      unboundedOutput: true,
    });

    expect(res).toEqual({ result: 42, logs: ["from offscreen"] });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const payload = sendMessage.mock.calls[0]![0];
    expect(payload).toMatchObject({
      target: "offscreen",
      type: "SANDBOX_EXECUTE",
      code: "return 1+1",
      input: { x: 1 },
      options: { timeoutMs: 5000, unboundedOutput: true },
    });
  });

  it("in SW context, surfaces transport errors as ExecuteCodeResult.error", async () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());

    const sendMessage = vi.fn().mockRejectedValue(new Error("offscreen gone"));
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        getURL: (p: string) => p,
        getContexts: vi.fn().mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]),
      },
      offscreen: { createDocument: vi.fn() },
    });

    const { executeInSandbox } = await import("../sandbox");
    const res = await executeInSandbox("return 1");
    expect(res.logs).toEqual([]);
    expect(res.error).toContain("offscreen gone");
  });

  it("in offscreen context, runs the local iframe path (does not call runtime.sendMessage)", async () => {
    // Simulate offscreen: document.URL ends in /offscreen.html, no SWGS.
    vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
    const fakeIframe = {
      contentWindow: {
        postMessage: vi.fn(),
      },
      style: {} as Record<string, string>,
      getAttribute: vi.fn().mockReturnValue("1"),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      parentNode: {},
    };
    const fakeDocument = {
      URL: "chrome-extension://test/offscreen.html",
      createElement: vi.fn().mockReturnValue(fakeIframe),
      body: { appendChild: vi.fn() },
    };
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", {
      addEventListener: vi.fn((evt: string, handler: (e: MessageEvent) => void) => {
        // Simulate the sandbox iframe responding with a result right away.
        if (evt === "message") {
          queueMicrotask(() => {
            handler({
              data: { id: 1, result: "ok-from-iframe", logs: [] },
            } as MessageEvent);
          });
        }
      }),
      removeEventListener: vi.fn(),
    });
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage, getURL: (p: string) => p },
    });

    const { executeInSandbox } = await import("../sandbox");
    const res = await executeInSandbox("return 'ok'");
    expect(res.result).toBe("ok-from-iframe");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
