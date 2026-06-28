import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `sendMcpMessage` parity test for the SW-host bridge: when invoked
 * from the service worker realm, it must bypass
 * `chrome.runtime.sendMessage` (the SW cannot deliver messages to its
 * own listeners) and invoke `handleMcpMessage` in-process instead.
 *
 * Renderer-realm callers continue to use the wire protocol unchanged.
 */

describe("sendMcpMessage realm dispatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("in renderer context, calls chrome.runtime.sendMessage", async () => {
    vi.stubGlobal("ServiceWorkerGlobalScope", undefined);
    vi.stubGlobal("document", {
      URL: "chrome-extension://test/sidepanel.html",
    });
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      states: [],
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    vi.resetModules();
    const { sendMcpMessage } = await import("../messages");
    const res = await sendMcpMessage({ type: "MCP_GET_STATES" });

    expect(sendMessage).toHaveBeenCalledWith({ type: "MCP_GET_STATES" });
    expect(res).toEqual({ ok: true, states: [] });
  });

  it("in SW context, invokes the handler in-process", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    vi.doMock("@/entrypoints/background/mcp-messages", () => ({
      handleMcpMessage: (
        _msg: { type: string },
        sendResponse: (r: unknown) => void,
      ) => {
        sendResponse({ ok: true, tools: [{ name: "mocked-tool" }] });
        return true;
      },
    }));

    vi.resetModules();
    const { sendMcpMessage } = await import("../messages");
    const res = (await sendMcpMessage({ type: "MCP_GET_TOOLS" })) as {
      ok: true;
      tools: Array<{ name: string }>;
    };

    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.tools[0]!.name).toBe("mocked-tool");
  });
});
