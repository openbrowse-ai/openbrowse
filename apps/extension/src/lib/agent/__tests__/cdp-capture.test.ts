import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  __test_pushNetwork,
  __test_pushConsole,
  __test_reset,
  readNetwork,
  readConsole,
  handleCdpEvent,
  flushTab,
  startCapture,
  releaseAll,
  isCapturing,
} from "../cdp-capture";
import { __test_reset as resetSession, releaseAll as releaseAllSessions } from "../cdp-session";

const TAB = 1;

beforeEach(() => {
  __test_reset();
  // cdp-capture now delegates attach to cdp-session; reset its sessions
  // map between tests so per-test mocks of chrome.debugger.attach actually
  // get invoked instead of short-circuiting on a leftover session entry.
  resetSession();
  vi.restoreAllMocks();
});

describe("cdp-capture ring buffer", () => {
  it("returns captured:false for an untracked tab", () => {
    const r = readNetwork(999, {});
    expect(r.captured).toBe(false);
    expect(r.requests).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("records and reads network entries", () => {
    __test_pushNetwork(TAB, { requestId: "1", url: "https://x.com/api/a", method: "GET", resourceType: "XHR", ts: 1 });
    const r = readNetwork(TAB, {});
    expect(r.captured).toBe(true);
    expect(r.total).toBe(1);
    expect(r.requests[0].url).toBe("https://x.com/api/a");
  });

  it("filters network by urlPattern substring", () => {
    __test_pushNetwork(TAB, { requestId: "1", url: "https://x.com/api/a", method: "GET", resourceType: "XHR", ts: 1 });
    __test_pushNetwork(TAB, { requestId: "2", url: "https://x.com/img.png", method: "GET", resourceType: "Image", ts: 2 });
    const r = readNetwork(TAB, { urlPattern: "/api/" });
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0].requestId).toBe("1");
  });

  it("evicts oldest beyond cap 200", () => {
    for (let i = 0; i < 250; i++) {
      __test_pushNetwork(TAB, { requestId: String(i), url: `https://x.com/${i}`, method: "GET", resourceType: "XHR", ts: i });
    }
    const r = readNetwork(TAB, { limit: 1000 });
    expect(r.requests).toHaveLength(200);
    expect(r.requests[0].requestId).toBe("50"); // 0..49 evicted
  });

  it("applies limit (most recent N) after filter", () => {
    for (let i = 0; i < 10; i++) {
      __test_pushNetwork(TAB, { requestId: String(i), url: `https://x.com/${i}`, method: "GET", resourceType: "XHR", ts: i });
    }
    const r = readNetwork(TAB, { limit: 3 });
    expect(r.requests.map((x) => x.requestId)).toEqual(["7", "8", "9"]);
    expect(r.total).toBe(10);
  });

  it("clear drains the network buffer", () => {
    __test_pushNetwork(TAB, { requestId: "1", url: "https://x.com/a", method: "GET", resourceType: "XHR", ts: 1 });
    readNetwork(TAB, { clear: true });
    const r = readNetwork(TAB, {});
    expect(r.total).toBe(0);
    expect(r.captured).toBe(true); // tab still tracked, just emptied
  });

  it("filters console by regex pattern and onlyErrors", () => {
    __test_pushConsole(TAB, { level: "log", text: "hello world", ts: 1 });
    __test_pushConsole(TAB, { level: "error", text: "boom failed", ts: 2 });
    expect(readConsole(TAB, { pattern: "world" }).messages).toHaveLength(1);
    expect(readConsole(TAB, { onlyErrors: true }).messages.map((m) => m.text)).toEqual(["boom failed"]);
  });
});

describe("cdp-capture event mapping", () => {
  it("maps Network.requestWillBeSent then responseReceived", () => {
    handleCdpEvent(TAB, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://x.com/api", method: "POST" },
      type: "XHR",
    });
    handleCdpEvent(TAB, "Network.responseReceived", {
      requestId: "r1",
      response: { status: 200, statusText: "OK", fromDiskCache: false },
    });
    const r = readNetwork(TAB, {});
    expect(r.requests[0]).toMatchObject({
      requestId: "r1", url: "https://x.com/api", method: "POST",
      resourceType: "XHR", status: 200, statusText: "OK",
    });
  });

  it("maps Network.loadingFailed", () => {
    handleCdpEvent(TAB, "Network.requestWillBeSent", {
      requestId: "r2", request: { url: "https://x.com/bad", method: "GET" }, type: "Fetch",
    });
    handleCdpEvent(TAB, "Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_FAILED" });
    const r = readNetwork(TAB, {});
    expect(r.requests[0]).toMatchObject({ failed: true, errorText: "net::ERR_FAILED" });
  });

  it("maps Runtime.consoleAPICalled args to text+level", () => {
    handleCdpEvent(TAB, "Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ value: "hi" }, { value: 42 }],
    });
    const r = readConsole(TAB, {});
    expect(r.messages[0]).toMatchObject({ level: "warn", text: "hi 42" });
  });

  it("maps Runtime.exceptionThrown to an error entry", () => {
    handleCdpEvent(TAB, "Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } },
    });
    const r = readConsole(TAB, { onlyErrors: true });
    expect(r.messages[0]).toMatchObject({ level: "error", text: "TypeError: boom" });
  });

  it("flushTab clears buffers but keeps the tab tracked", () => {
    handleCdpEvent(TAB, "Network.requestWillBeSent", {
      requestId: "r3", request: { url: "https://x.com/a", method: "GET" }, type: "XHR",
    });
    flushTab(TAB);
    const r = readNetwork(TAB, {});
    expect(r.total).toBe(0);
    expect(r.captured).toBe(true);
  });
});

describe("cdp-capture lifecycle", () => {
  it("startCapture attaches, enables Network, and tracks the tab", async () => {
    const attach = vi.spyOn(chrome.debugger, "attach").mockResolvedValue(undefined as never);
    const send = vi.spyOn(chrome.debugger, "sendCommand").mockResolvedValue(undefined as never);
    await startCapture(TAB);
    expect(attach).toHaveBeenCalledWith({ tabId: TAB }, "1.3");
    expect(send).toHaveBeenCalledWith({ tabId: TAB }, "Network.enable");
    // tracked now → reads return captured:true even with empty buffers
    expect(readNetwork(TAB, {}).captured).toBe(true);
  });

  it("startCapture is idempotent (no double attach)", async () => {
    const attach = vi.spyOn(chrome.debugger, "attach").mockResolvedValue(undefined as never);
    vi.spyOn(chrome.debugger, "sendCommand").mockResolvedValue(undefined as never);
    await startCapture(TAB);
    await startCapture(TAB);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("releaseAll clears tracked + buffers (detach is owned by cdp-session.releaseAll)", async () => {
    vi.spyOn(chrome.debugger, "attach").mockResolvedValue(undefined as never);
    vi.spyOn(chrome.debugger, "sendCommand").mockResolvedValue(undefined as never);
    const detach = vi.spyOn(chrome.debugger, "detach").mockResolvedValue(undefined as never);
    await startCapture(TAB);
    releaseAll();
    // Architecture: cdp-capture no longer calls chrome.debugger.detach
    // directly. Tearing down the underlying session is the job of
    // cdp-session.releaseAll() (called from agent-transport's done-working
    // hook). cdp-capture.releaseAll() just drops the routing flags +
    // buffers.
    expect(detach).not.toHaveBeenCalled();
    expect(readNetwork(TAB, {}).captured).toBe(false);
    expect(isCapturing(TAB)).toBe(false);
  });

  it("cdp-session.releaseAll synthesizes a detach that wipes capture state", async () => {
    vi.spyOn(chrome.debugger, "attach").mockResolvedValue(undefined as never);
    vi.spyOn(chrome.debugger, "sendCommand").mockResolvedValue(undefined as never);
    const detach = vi.spyOn(chrome.debugger, "detach").mockResolvedValue(undefined as never);
    await startCapture(TAB);
    expect(isCapturing(TAB)).toBe(true);
    // The canonical "agent done working" path is releaseAllSessions, which
    // detaches Chrome AND fires our onDetach subscriber per tab to clear
    // capture's routing flags + buffers symmetrically.
    releaseAllSessions();
    expect(detach).toHaveBeenCalledWith({ tabId: TAB });
    expect(readNetwork(TAB, {}).captured).toBe(false);
    expect(isCapturing(TAB)).toBe(false);
  });

  it("startCapture propagates non-already-attached errors and leaves no phantom capture", async () => {
    vi.spyOn(chrome.debugger, "attach").mockRejectedValue(
      new Error("No tab with given id"),
    );
    vi.spyOn(chrome.debugger, "sendCommand").mockResolvedValue(undefined as never);
    // cdp-session's doAttach wraps the error as
    // "Cannot attach debugger to tab N: No tab with given id".
    // cdp-capture rethrows whatever cdp-session throws.
    await expect(startCapture(TAB)).rejects.toThrow(/No tab with given id/);
    // Must not be tracked AND must not have a phantom captures entry.
    const r = readNetwork(TAB, {});
    expect(r.captured).toBe(false);
    expect(r.total).toBe(0);
  });
});

describe("cdp-capture onEvent wiring", () => {
  it("routes onEvent to handleCdpEvent for tracked tabs only", async () => {
    // Capture the registered listener at module-load time by spying on
    // addListener BEFORE we re-import the module.
    let listener:
      | ((src: { tabId?: number }, method: string, params?: unknown) => void)
      | undefined;
    vi.spyOn(chrome.debugger.onEvent, "addListener").mockImplementation((fn) => {
      listener = fn as typeof listener;
    });
    vi.resetModules();
    const mod = await import("../cdp-capture");
    mod.__test_reset();
    vi.spyOn(chrome.debugger, "attach").mockResolvedValue(undefined as never);
    vi.spyOn(chrome.debugger, "sendCommand").mockResolvedValue(undefined as never);
    await mod.startCapture(TAB);
    listener?.({ tabId: TAB }, "Network.requestWillBeSent", {
      requestId: "z",
      request: { url: "https://x.com/api", method: "GET" },
      type: "XHR",
    });
    listener?.({ tabId: 777 }, "Network.requestWillBeSent", {
      requestId: "y",
      request: { url: "https://other", method: "GET" },
      type: "XHR",
    });
    expect(mod.readNetwork(TAB, {}).total).toBe(1);
    expect(mod.readNetwork(777, {}).captured).toBe(false); // untracked → ignored
  });

  it("onDetach flushes the tab's buffer and re-arms capture", async () => {
    // Same listener-capture trick but for onDetach AND onEvent (so we can
    // verify post-rearm capture still routes events).
    let onEventListener:
      | ((src: { tabId?: number }, method: string, params?: unknown) => void)
      | undefined;
    let onDetachListener:
      | ((src: { tabId?: number }, reason?: string) => void)
      | undefined;
    vi.spyOn(chrome.debugger.onEvent, "addListener").mockImplementation((fn) => {
      onEventListener = fn as typeof onEventListener;
    });
    vi.spyOn(chrome.debugger.onDetach, "addListener").mockImplementation((fn) => {
      onDetachListener = fn as typeof onDetachListener;
    });
    vi.resetModules();
    const mod = await import("../cdp-capture");
    mod.__test_reset();
    const attach = vi
      .spyOn(chrome.debugger, "attach")
      .mockResolvedValue(undefined as never);
    vi.spyOn(chrome.debugger, "sendCommand").mockResolvedValue(undefined as never);

    await mod.startCapture(TAB);
    // Record one entry pre-detach.
    onEventListener?.({ tabId: TAB }, "Network.requestWillBeSent", {
      requestId: "before",
      request: { url: "https://x.com/api", method: "GET" },
      type: "XHR",
    });
    expect(mod.readNetwork(TAB, {}).total).toBe(1);

    // Cross-domain navigation: Chrome fires onDetach.
    onDetachListener?.({ tabId: TAB }, "target_closed");
    // Wait a microtask for the re-arm's startCapture to settle.
    await Promise.resolve();
    await Promise.resolve();

    // Buffer flushed BUT tab is still captured (re-armed).
    const r = mod.readNetwork(TAB, {});
    expect(r.total).toBe(0);
    expect(r.captured).toBe(true);

    // Confirm post-rearm events still flow.
    onEventListener?.({ tabId: TAB }, "Network.requestWillBeSent", {
      requestId: "after",
      request: { url: "https://x.com/page2", method: "GET" },
      type: "XHR",
    });
    expect(mod.readNetwork(TAB, {}).total).toBe(1);
    expect(mod.readNetwork(TAB, {}).requests[0].requestId).toBe("after");

    // Re-arm called startCapture again → second attach call.
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("onDetach is a no-op for untracked tabs", async () => {
    let onDetachListener:
      | ((src: { tabId?: number }, reason?: string) => void)
      | undefined;
    vi.spyOn(chrome.debugger.onDetach, "addListener").mockImplementation((fn) => {
      onDetachListener = fn as typeof onDetachListener;
    });
    vi.resetModules();
    const mod = await import("../cdp-capture");
    mod.__test_reset();
    const attach = vi
      .spyOn(chrome.debugger, "attach")
      .mockResolvedValue(undefined as never);
    // Untracked tab.
    onDetachListener?.({ tabId: 999 });
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();
    expect(mod.readNetwork(999, {}).captured).toBe(false);
  });
});
