import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `executePythonRPC` (and the other PYTHON_* helpers) must NOT route
 * through `chrome.runtime.sendMessage` when called from the service
 * worker realm — the SW cannot deliver messages to its own listeners,
 * so the call would land only in the offscreen document (whose
 * listener guards on `target === "offscreen"` and silently ignores the
 * raw envelope), the port would close with no response, and the
 * executePython tool would surface "Error (Internal): The message
 * port closed before a response was received." in the chat UI.
 *
 * Instead, the SW realm must invoke `handlePythonMessage` in-process.
 * Renderer realms continue to use `chrome.runtime.sendMessage`
 * unchanged.
 */

describe("executePythonRPC realm dispatch", () => {
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
      stdout: "hello world\n",
      stderr: "",
      timings: { runMs: 1 },
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    vi.resetModules();
    const { executePythonRPC } = await import("../messages");
    const res = await executePythonRPC({
      conversationId: "c1",
      spaceId: null,
      code: "print('hello world')",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PYTHON_EXECUTE",
        conversationId: "c1",
        spaceId: null,
        code: "print('hello world')",
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.stdout).toBe("hello world\n");
  });

  it("in SW context, does NOT call chrome.runtime.sendMessage and invokes the handler in-process", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    // Mock the SW-side handler module so we don't drag the real
    // offscreen-document ensure path into the unit test.
    vi.doMock("@/entrypoints/background/python-messages", () => ({
      handlePythonMessage: vi.fn(
        (
          msg: { type: string; code?: string },
          sendResponse: (r: unknown) => void,
        ) => {
          sendResponse({
            ok: true,
            result: msg.code,
            stdout: "",
            stderr: "",
            timings: { runMs: 0 },
          });
          return true;
        },
      ),
    }));

    vi.resetModules();
    const { executePythonRPC } = await import("../messages");
    const res = await executePythonRPC({
      conversationId: "c1",
      spaceId: null,
      code: "1 + 1",
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.result).toBe("1 + 1");
  });

  it("in SW context, surfaces transport-style errors as thrown errors (no stdout in envelope)", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    vi.doMock("@/entrypoints/background/python-messages", () => ({
      handlePythonMessage: (
        _msg: unknown,
        sendResponse: (r: unknown) => void,
      ) => {
        // Transport-style error envelope: only `error` field, no
        // `stdout`. Mirrors the offscreen-relay-fault path in the
        // real handler.
        sendResponse({ error: "offscreen document missing" });
        return true;
      },
    }));

    vi.resetModules();
    const { executePythonRPC } = await import("../messages");
    await expect(
      executePythonRPC({
        conversationId: "c1",
        spaceId: null,
        code: "1",
      }),
    ).rejects.toThrow(/offscreen document missing/);
  });

  it("in SW context, resolves structured PythonError responses (has stdout AND error)", async () => {
    // A genuine Python exception is a SUCCESSFUL transport with
    // `ok: false`, `errorKind: "PythonError"`, and a populated
    // `stdout`/`stderr`. It must resolve so the tool surface can
    // render the structured failure (red error banner with the
    // traceback). It must NOT reject — rejection would route through
    // the executePython tool's catch and lose the timings + stderr.
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn() } });

    vi.doMock("@/entrypoints/background/python-messages", () => ({
      handlePythonMessage: (
        _msg: unknown,
        sendResponse: (r: unknown) => void,
      ) => {
        sendResponse({
          ok: false,
          stdout: "before crash\n",
          stderr: "Traceback ...",
          error: "NameError: 'x' is not defined",
          errorKind: "PythonError",
          timings: { runMs: 42 },
        });
        return true;
      },
    }));

    vi.resetModules();
    const { executePythonRPC } = await import("../messages");
    const res = await executePythonRPC({
      conversationId: "c1",
      spaceId: null,
      code: "x",
    });

    expect(res.ok).toBe(false);
    expect(res.errorKind).toBe("PythonError");
    expect(res.error).toMatch(/NameError/);
    expect(res.stdout).toBe("before crash\n");
    expect(res.timings.runMs).toBe(42);
  });

  it("warmup/reset/dispose helpers use the same realm-aware dispatch", async () => {
    class FakeSWGS {}
    vi.stubGlobal("ServiceWorkerGlobalScope", FakeSWGS);
    vi.stubGlobal("self", new FakeSWGS());
    vi.stubGlobal("document", undefined);
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const seenTypes: string[] = [];
    vi.doMock("@/entrypoints/background/python-messages", () => ({
      handlePythonMessage: (
        msg: { type: string },
        sendResponse: (r: unknown) => void,
      ) => {
        seenTypes.push(msg.type);
        if (msg.type === "PYTHON_WARMUP") {
          sendResponse({ loadMs: 1000 });
        } else {
          sendResponse({ ok: true });
        }
        return true;
      },
    }));

    vi.resetModules();
    const { warmupPythonRPC, resetPythonRPC, disposePythonRPC } = await import(
      "../messages"
    );

    const w = await warmupPythonRPC("c1");
    const r = await resetPythonRPC("c1");
    const d = await disposePythonRPC("c1");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(seenTypes).toEqual([
      "PYTHON_WARMUP",
      "PYTHON_RESET",
      "PYTHON_DISPOSE",
    ]);
    expect(w.loadMs).toBe(1000);
    expect(r.ok).toBe(true);
    expect(d.ok).toBe(true);
  });
});
