// apps/extension/src/entrypoints/artifact/__tests__/bridge-shim-exec.test.ts
// @vitest-environment happy-dom
//
// Executes the real BRIDGE_SHIM_SOURCE in a DOM and exercises
// openbrowse.network.fetch end-to-end against a faked broker, so the
// Response-reconstruction path is actually run (not just string-matched).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BRIDGE_SHIM_SOURCE } from "../bridge-shim";
import { arrayBufferToBase64, base64ToArrayBuffer } from "@/lib/artifacts/base64";

type BrokerResult = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyB64: string;
};

/** Build a broker result from text or bytes (mirrors what the background does). */
function brokerBody(
  body: string | ArrayBuffer | Uint8Array,
  init: { status?: number; statusText?: string; headers?: Record<string, string> } = {},
): BrokerResult {
  let buf: ArrayBuffer;
  if (typeof body === "string") buf = new TextEncoder().encode(body).buffer;
  else if (body instanceof Uint8Array) buf = body.slice().buffer as ArrayBuffer;
  else buf = body;
  return {
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: init.headers ?? {},
    bodyB64: arrayBufferToBase64(buf),
  };
}

let brokerHandler: (method: string, payload: Record<string, unknown>) => BrokerResult;
let captured: { method: string; payload: Record<string, unknown> }[] = [];

function installBroker() {
  captured = [];
  // The shim posts { type: "ART_RPC", reqId, method, ...payload } to
  // window.parent. In happy-dom parent === window, so we listen here and
  // reply with ART_RPC_OK carrying the broker result.
  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as Record<string, unknown>;
    if (!m || m.type !== "ART_RPC") return;
    const { reqId, method, type: _t, ...payload } = m;
    captured.push({ method: method as string, payload });
    let result: unknown;
    try {
      result = brokerHandler(method as string, payload);
    } catch (err) {
      window.postMessage({ type: "ART_RPC_ERR", reqId, error: String(err) }, "*");
      return;
    }
    window.postMessage({ type: "ART_RPC_OK", reqId, result }, "*");
  });
}

function loadShim() {
  // Reset any prior install so the IIFE's `if (window.openbrowse) return` guard
  // doesn't short-circuit between tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).openbrowse;
  // eslint-disable-next-line @typescript-eslint/no-new-func
  new Function(BRIDGE_SHIM_SOURCE)();
}

beforeEach(() => {
  installBroker();
  loadShim();
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).openbrowse;
  document.documentElement.classList.remove("dark");
  document.documentElement.style.cssText = "";
});

// happy-dom delivers postMessage asynchronously; the shim's rpc() resolves on
// the reply, so awaiting the fetch promise is enough.
describe("bridge-shim networkFetch (executed)", () => {
  it("reconstructs a 200 text Response", async () => {
    brokerHandler = () => brokerBody("hello world", { headers: { "content-type": "text/plain" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: Response = await (window as any).openbrowse.network.fetch("https://api.example.com/x");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain");
    expect(await r.text()).toBe("hello world");
  });

  it("defaults credentials to omit and forwards method/headers/string body", async () => {
    brokerHandler = () => brokerBody("ok");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).openbrowse.network.fetch("https://api.example.com/x", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: "payload",
    });
    const call = captured.find((c) => c.method === "network.fetch")!;
    const init = call.payload.init as Record<string, unknown>;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.body).toBe("payload");
    expect(init.bodyB64).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("base64-encodes a binary request body as bodyB64", async () => {
    brokerHandler = () => brokerBody("ok");
    const bytes = new Uint8Array([10, 20, 30, 240]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).openbrowse.network.fetch("https://api.example.com/x", {
      method: "POST",
      body: bytes,
    });
    const call = captured.find((c) => c.method === "network.fetch")!;
    const init = call.payload.init as Record<string, unknown>;
    expect(init.body).toBeUndefined();
    expect(typeof init.bodyB64).toBe("string");
    const decoded = new Uint8Array(base64ToArrayBuffer(init.bodyB64 as string));
    expect(Array.from(decoded)).toEqual([10, 20, 30, 240]);
  });

  it("honors an explicit credentials: include", async () => {
    brokerHandler = () => brokerBody("ok");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).openbrowse.network.fetch("https://api.example.com/x", {
      credentials: "include",
    });
    const call = captured.find((c) => c.method === "network.fetch")!;
    expect((call.payload.init as Record<string, unknown>).credentials).toBe("include");
  });

  it("reconstructs a 204 (null-body) status WITHOUT throwing", async () => {
    // NOTE: happy-dom's Response is lenient about 204+body (real Chrome
    // throws), so this only exercises the shim's request/response plumbing,
    // not the strict null-body rule. The strict rule is covered by
    // lib/artifacts/__tests__/response-status.test.ts.
    brokerHandler = () => brokerBody("", { status: 204, statusText: "No Content" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: Response = await (window as any).openbrowse.network.fetch("https://api.example.com/x");
    expect(r.status).toBe(204);
  });

  it("round-trips a binary body via base64", async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    brokerHandler = () => brokerBody(bytes, { headers: { "content-type": "application/octet-stream" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: Response = await (window as any).openbrowse.network.fetch("https://api.example.com/blob");
    const out = new Uint8Array(await r.arrayBuffer());
    expect(Array.from(out)).toEqual([0, 1, 2, 253, 254, 255]);
  });

  it("propagates a broker error as a rejected promise", async () => {
    brokerHandler = () => {
      throw new Error("network.fetch: host not allowed");
    };
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).openbrowse.network.fetch("https://evil.com/x"),
    ).rejects.toThrow(/host not allowed/);
  });

  it("forwards console.* to the host as ART_CONSOLE messages", async () => {
    const consoleMsgs: { level: string; text: string }[] = [];
    const onMsg = (e: MessageEvent) => {
      const m = e.data as Record<string, unknown>;
      if (m && m.type === "ART_CONSOLE") consoleMsgs.push({ level: m.level as string, text: m.text as string });
    };
    window.addEventListener("message", onMsg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).console.log("hello", { a: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).console.warn("danger");
    await new Promise((r) => setTimeout(r, 10));
    window.removeEventListener("message", onMsg);
    expect(consoleMsgs.some((m) => m.level === "log" && m.text.includes("hello"))).toBe(true);
    expect(consoleMsgs.some((m) => m.level === "warn" && m.text === "danger")).toBe(true);
  });

  it("ART_INIT applies theme vars verbatim and toggles html.dark", async () => {
    // The Host sends resolved color strings (e.g. oklch(...)). The shim must
    // set them as-is and reflect mode on <html>.dark.
    window.postMessage(
      {
        type: "ART_INIT",
        theme: { mode: "dark", vars: { "--ob-bg": "oklch(0.24 0.01 75)", "--ob-fg": "#fafafa" } },
        identity: { id: "x", title: "X", mode: "tab" },
      },
      "*",
    );
    await new Promise((r) => setTimeout(r, 10));
    const root = document.documentElement;
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.getPropertyValue("--ob-bg")).toBe("oklch(0.24 0.01 75)");
    expect(root.style.getPropertyValue("--ob-fg")).toBe("#fafafa");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("ART_THEME switching to light removes html.dark and fires onThemeChange", async () => {
    document.documentElement.classList.add("dark");
    const seen: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).openbrowse.onThemeChange((t: { mode: string }) => seen.push(t.mode));
    window.postMessage({ type: "ART_THEME", theme: { mode: "light", vars: {} } }, "*");
    await new Promise((r) => setTimeout(r, 10));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(seen).toContain("light");
  });

  it("posts ART_RENDERED once the document is ready", async () => {
    // The shim is loaded (in beforeEach) after happy-dom's document is already
    // parsed, so the rendered signal fires on the deferred-task branch. Body
    // has some content here, so childCount/bodyTextSample should reflect it.
    document.body.innerHTML = "<main><h1>Hello</h1></main>";
    const rendered: { childCount: number; bodyTextSample: string }[] = [];
    const onMsg = (e: MessageEvent) => {
      const m = e.data as Record<string, unknown>;
      if (m && m.type === "ART_RENDERED") {
        rendered.push({
          childCount: m.childCount as number,
          bodyTextSample: m.bodyTextSample as string,
        });
      }
    };
    window.addEventListener("message", onMsg);
    // Re-load the shim so its readyState check + setTimeout(0) runs against the
    // populated body (beforeEach already loaded it once, but its deferred task
    // ran against an empty body before this test's innerHTML assignment).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).openbrowse;
    // eslint-disable-next-line @typescript-eslint/no-new-func
    new Function(BRIDGE_SHIM_SOURCE)();
    await new Promise((r) => setTimeout(r, 10));
    window.removeEventListener("message", onMsg);
    expect(rendered.length).toBeGreaterThanOrEqual(1);
    expect(rendered[rendered.length - 1].childCount).toBe(1);
    expect(rendered[rendered.length - 1].bodyTextSample).toContain("Hello");
  });
});
