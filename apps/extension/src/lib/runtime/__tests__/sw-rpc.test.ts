import { afterEach, describe, expect, it, vi } from "vitest";
import { swRpc } from "../sw-rpc";

/**
 * `swRpc` dispatches a `chrome.runtime.sendMessage`-style RPC payload
 * either in-process (when the caller IS the service worker — the SW
 * cannot deliver `sendMessage` to its own listeners) or out-of-process
 * via `chrome.runtime.sendMessage` (every other realm).
 *
 * The decision boundary is `isServiceWorkerContext()`. In-process
 * dispatch invokes a caller-provided `handler` whose signature
 * matches the SW's existing `handleXxxMessage(message, sendResponse)`
 * pattern — same shape, no adapter needed at call sites that already
 * have such a handler.
 */

describe("swRpc", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubRendererRealm(): void {
    vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
    vi.stubGlobal("document", {
      URL: "chrome-extension://test/sidepanel.html",
    });
  }

  function stubSwRealm(): void {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
  }

  it("in renderer context, delegates to chrome.runtime.sendMessage", async () => {
    stubRendererRealm();
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, value: 42 });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const handler = vi.fn();
    const result = await swRpc(
      { type: "TEST_MESSAGE", payload: "x" },
      async () => handler as never,
    );

    expect(sendMessage).toHaveBeenCalledWith({
      type: "TEST_MESSAGE",
      payload: "x",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("in SW context, invokes the handler in-process and does not call chrome.runtime.sendMessage", async () => {
    stubSwRealm();
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const handler = vi.fn((msg: unknown, sendResponse: (r: unknown) => void) => {
      // Match the production sync-then-async pattern: handler may call
      // sendResponse synchronously or asynchronously.
      sendResponse({ echoed: msg, ok: true });
    });

    const result = await swRpc(
      { type: "TEST_MESSAGE", payload: "x" },
      async () => handler as never,
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      echoed: { type: "TEST_MESSAGE", payload: "x" },
      ok: true,
    });
  });

  it("in SW context, waits for an async handler to call sendResponse", async () => {
    stubSwRealm();
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const handler = (_msg: unknown, sendResponse: (r: unknown) => void) => {
      setTimeout(() => sendResponse({ ok: true, delayed: true }), 10);
      return true;
    };

    const result = await swRpc(
      { type: "TEST_MESSAGE" },
      async () => handler as never,
    );
    expect(result).toEqual({ ok: true, delayed: true });
  });

  it("in SW context, surfaces handler-thrown errors as rejections", async () => {
    stubSwRealm();
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    const handler = () => {
      throw new Error("handler blew up");
    };

    await expect(
      swRpc({ type: "TEST_MESSAGE" }, async () => handler as never),
    ).rejects.toThrow(/handler blew up/);
  });

  it("in SW context, if handler never calls sendResponse, the promise hangs (caller must guard with timeout)", async () => {
    stubSwRealm();
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    const handler = (_msg: unknown, _sendResponse: (r: unknown) => void) => {
      // Never calls sendResponse — production handlers always do, but we
      // pin the documented behavior so a regression is visible.
    };

    const racing = await Promise.race([
      swRpc({ type: "TEST_MESSAGE" }, async () => handler as never).then(
        () => "resolved",
      ),
      new Promise((r) => setTimeout(() => r("timed-out"), 30)),
    ]);
    expect(racing).toBe("timed-out");
  });
});
