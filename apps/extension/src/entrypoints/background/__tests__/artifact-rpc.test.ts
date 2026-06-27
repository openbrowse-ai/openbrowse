import { describe, it, expect, vi, beforeEach } from "vitest";

const registry = vi.hoisted(() => ({
  callTool: vi.fn(async (_s: string, _t: string, _a: unknown) => "MCP_RESULT"),
  ensureServerConnected: vi.fn(async (_s: string) => true),
}));
vi.mock("../mcp-registry", () => ({ backgroundMcpRegistry: registry }));

const connectors = vi.hoisted(() => ({
  getConnector: vi.fn((id: string) =>
    id === "linear" ? { id: "linear", url: "https://mcp.linear.app/mcp" } : undefined,
  ),
}));
vi.mock("@openbrowse/connectors", () => connectors);

const storageMock = vi.hoisted(() => ({
  storage: {
    getSettings: vi.fn(async () => ({
      mcpServers: [
        { id: "linear-uuid", url: "https://mcp.linear.app/mcp", enabled: true },
      ],
    })),
  },
}));
vi.mock("@/lib/storage", () => storageMock);

const defaultReadFile = async (p: string): Promise<string> => {
  if (p.endsWith(".html")) {
    return `<meta name="openbrowse:artifact" content='${JSON.stringify({
      v: 1, id: "art", title: "X",
      tools: [
        { name: "mcp.linear.search_issues", mode: "read" },
        { name: "mcp.linear.update_issue", mode: "write" },
      ],
    })}'>`;
  }
  return JSON.stringify({
    id: "art", createdAt: "t", updatedAt: "t",
    approvedWrites: ["mcp.linear.update_issue"],
    approvedNetwork: [], manifestVersion: "v",
  });
};

const opfs = vi.hoisted(() => ({
  exists: vi.fn(async (_p: string) => true),
  readFile: vi.fn(),
  readDir: vi.fn(async (_p: string) => [] as string[]),
  writeFileAtomic: vi.fn(async (_p: string, _c: string) => undefined),
  rm: vi.fn(async (_p: string, _o?: { recursive?: boolean }) => undefined),
  mkdir: vi.fn(async (_p: string) => undefined),
}));
vi.mock("@/lib/vfs/opfs", () => ({ OPFS: opfs }));

import { handleArtifactRpc, readBodyCapped } from "../artifact-rpc";
import { base64ToArrayBuffer, arrayBufferToBase64 } from "@/lib/artifacts/base64";

/** Decode the brokered result's base64 body back to bytes / text. */
function resultBytes(result: unknown): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer((result as { bodyB64: string }).bodyB64));
}
function resultText(result: unknown): string {
  return new TextDecoder().decode(resultBytes(result));
}

beforeEach(() => {
  registry.callTool.mockClear();
  registry.callTool.mockImplementation(async (_s: string, _t: string, _a: unknown) => "MCP_RESULT");
  registry.ensureServerConnected.mockReset();
  registry.ensureServerConnected.mockImplementation(async (_s: string) => true);
  connectors.getConnector.mockClear();
  connectors.getConnector.mockImplementation((id: string) =>
    id === "linear" ? { id: "linear", url: "https://mcp.linear.app/mcp" } : undefined,
  );
  storageMock.storage.getSettings.mockClear();
  storageMock.storage.getSettings.mockResolvedValue({
    mcpServers: [
      { id: "linear-uuid", url: "https://mcp.linear.app/mcp", enabled: true },
    ],
  });
  opfs.exists.mockReset();
  opfs.exists.mockImplementation(async (_p: string) => true);
  opfs.readFile.mockReset();
  opfs.readFile.mockImplementation(defaultReadFile);
});

describe("artifact-rpc", () => {
  it("dispatches an approved read MCP call", async () => {
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "art", toolName: "mcp.linear.search_issues", args: { q: "foo" } },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.callTool).toHaveBeenCalledWith("linear-uuid", "search_issues", { q: "foo" });
    expect(resp).toEqual({ ok: true, result: "MCP_RESULT" });
  });

  it("rejects an undeclared tool", async () => {
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "art", toolName: "mcp.linear.delete_issue", args: {} },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(resp).toEqual({ ok: false, error: expect.stringMatching(/not declared/) });
  });

  it("rejects an unapproved write tool", async () => {
    // Override readFile so the manifest declares update_issue as write,
    // but the sidecar has no approved writes.
    opfs.readFile.mockImplementation(async (p: string): Promise<string> => {
      if (p.endsWith(".html")) {
        return `<meta name="openbrowse:artifact" content='${JSON.stringify({
          v: 1, id: "art", title: "X",
          tools: [{ name: "mcp.linear.update_issue", mode: "write" }],
        })}'>`;
      }
      return JSON.stringify({
        id: "art", createdAt: "t", updatedAt: "t",
        approvedWrites: [], approvedNetwork: [], manifestVersion: "v",
      });
    });
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "art", toolName: "mcp.linear.update_issue", args: {} },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(resp).toEqual({
      ok: false,
      error: "write tool 'mcp.linear.update_issue' not approved by user",
    });
  });

  it("rejects unknown artifactId", async () => {
    opfs.exists.mockResolvedValue(false);
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "ghost", toolName: "mcp.linear.search_issues", args: {} },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(resp).toEqual({ ok: false, error: "unknown artifact: ghost" });
  });

  it("returns error when MCP tool call rejects", async () => {
    registry.callTool.mockRejectedValueOnce(new Error("upstream MCP error"));
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "art", toolName: "mcp.linear.search_issues", args: {} },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(resp).toEqual({ ok: false, error: "upstream MCP error" });
  });

  it("returns a helpful error when the server cannot be connected", async () => {
    registry.ensureServerConnected.mockResolvedValueOnce(false);
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "art", toolName: "mcp.linear.search_issues", args: {} },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.callTool).not.toHaveBeenCalled();
    expect(resp).toEqual({
      ok: false,
      error: expect.stringMatching(/not connected/),
    });
  });

  it("lazily connects the server before dispatching", async () => {
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "art", toolName: "mcp.linear.search_issues", args: {} },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.ensureServerConnected).toHaveBeenCalledWith("linear-uuid");
    expect(resp).toEqual({ ok: true, result: "MCP_RESULT" });
  });

  it("resolves the connector id to the per-install server UUID", async () => {
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "art", toolName: "mcp.linear.search_issues", args: {} },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(connectors.getConnector).toHaveBeenCalledWith("linear");
    expect(registry.callTool).toHaveBeenCalledWith("linear-uuid", "search_issues", {});
  });

  it("returns a helpful error when no matching server is configured", async () => {
    storageMock.storage.getSettings.mockResolvedValueOnce({ mcpServers: [] });
    let resp: unknown = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_CALL_MCP", artifactId: "art", toolName: "mcp.linear.search_issues", args: {} },
      (r) => { resp = r; },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(registry.ensureServerConnected).not.toHaveBeenCalled();
    expect(registry.callTool).not.toHaveBeenCalled();
    expect(resp).toEqual({
      ok: false,
      error: expect.stringMatching(/not connected/),
    });
  });
});

describe("artifact-rpc network.fetch", () => {
  // Manifest with a network allowlist (exact host + wildcard).
  function withNetwork(allow: string[]) {
    opfs.readFile.mockImplementation(async (p: string): Promise<string> => {
      if (p.endsWith(".html")) {
        return `<meta name="openbrowse:artifact" content='${JSON.stringify({
          v: 1, id: "art", title: "X", tools: [], network: allow,
        })}'>`;
      }
      return JSON.stringify({
        id: "art", createdAt: "t", updatedAt: "t",
        approvedWrites: [], approvedNetwork: allow, manifestVersion: "v",
      });
    });
  }

  async function call(url: string, init: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    let resp: { ok: boolean; result?: unknown; error?: string } | null = null;
    handleArtifactRpc(
      { type: "ARTIFACT_RPC_NETWORK_FETCH", artifactId: "art", url, init } as never,
      (r) => { resp = r as never; },
    );
    // Wait until the async handler resolves.
    for (let i = 0; i < 50 && resp === null; i++) await new Promise((r) => setTimeout(r, 5));
    return resp!;
  }

  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  function res(body: string | ArrayBuffer, init: { status?: number; headers?: Record<string, string> } = {}) {
    return new Response(body, { status: init.status ?? 200, headers: init.headers });
  }

  it("fetches an allowed exact host and returns the body", async () => {
    withNetwork(["api.example.com"]);
    fetchMock.mockResolvedValue(res("hello"));
    const r = await call("https://api.example.com/data");
    expect(r.ok).toBe(true);
    const result = r.result as { status: number };
    expect(result.status).toBe(200);
    expect(resultText(r.result)).toBe("hello");
  });

  it("fetches an allowed wildcard host", async () => {
    withNetwork(["*.example.com"]);
    fetchMock.mockResolvedValue(res("ok"));
    const r = await call("https://api.example.com/x");
    expect(r.ok).toBe(true);
  });

  it("rejects a host not in the allowlist (no fetch)", async () => {
    withNetwork(["api.example.com"]);
    const r = await call("https://evil.com/x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in the artifact's network allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) scheme", async () => {
    withNetwork(["api.example.com"]);
    const r = await call("file:///etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/http\(s\)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips forbidden request headers (Cookie) but keeps Authorization", async () => {
    withNetwork(["api.example.com"]);
    fetchMock.mockResolvedValue(res("ok"));
    await call("https://api.example.com/x", {
      method: "POST",
      headers: { Cookie: "secret=1", Authorization: "Bearer t", "Content-Type": "application/json" },
      body: "{}",
    });
    const passedHeaders = (fetchMock.mock.calls[0][1] as { headers: Headers }).headers;
    expect(passedHeaders.get("cookie")).toBeNull();
    expect(passedHeaders.get("authorization")).toBe("Bearer t");
    expect(passedHeaders.get("content-type")).toBe("application/json");
  });

  it("defaults credentials to omit", async () => {
    withNetwork(["api.example.com"]);
    fetchMock.mockResolvedValue(res("ok"));
    await call("https://api.example.com/x");
    expect((fetchMock.mock.calls[0][1] as { credentials: string }).credentials).toBe("omit");
  });

  it("honors an explicit credentials: include", async () => {
    withNetwork(["api.example.com"]);
    fetchMock.mockResolvedValue(res("ok"));
    await call("https://api.example.com/x", { credentials: "include" });
    expect((fetchMock.mock.calls[0][1] as { credentials: string }).credentials).toBe("include");
  });

  it("rejects an oversized request body before fetching", async () => {
    withNetwork(["api.example.com"]);
    const big = "x".repeat(1024 * 1024 + 1);
    const r = await call("https://api.example.com/x", { method: "POST", body: big });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/request body exceeds/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips Set-Cookie from the response headers", async () => {
    withNetwork(["api.example.com"]);
    fetchMock.mockResolvedValue(res("ok", { headers: { "set-cookie": "a=1", "x-rate": "9" } }));
    const r = await call("https://api.example.com/x");
    const result = r.result as { headers: Record<string, string> };
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.headers["x-rate"]).toBe("9");
  });

  it("uses redirect: follow (manual redirect is not viable cross-origin in a SW)", async () => {
    withNetwork(["api.example.com"]);
    fetchMock.mockResolvedValue(res("ok"));
    await call("https://api.example.com/start");
    expect((fetchMock.mock.calls[0][1] as { redirect: string }).redirect).toBe("follow");
  });

  // Helper: a response that landed on `finalUrl` after following redirects.
  function landedOn(finalUrl: string, body = "body") {
    const r = res(body);
    Object.defineProperty(r, "url", { value: finalUrl, configurable: true });
    return r;
  }

  it("rejects when a redirect lands on a host outside the allowlist", async () => {
    withNetwork(["api.example.com"]);
    // Browser followed api.example.com -> evil.com; response.url is the final host.
    fetchMock.mockResolvedValue(landedOn("https://evil.com/x"));
    const r = await call("https://api.example.com/start");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/redirected to 'evil.com', which is not in the allowlist/);
  });

  it("accepts a redirect that lands on an allowed host", async () => {
    withNetwork(["api.example.com", "cdn.example.com"]);
    fetchMock.mockResolvedValue(landedOn("https://cdn.example.com/final", "final-body"));
    const r = await call("https://api.example.com/start");
    expect(r.ok).toBe(true);
    expect(resultText(r.result)).toBe("final-body");
  });

  it("rejects an opaqueredirect response instead of returning status 0", async () => {
    withNetwork(["api.example.com"]);
    // Simulate the SW cross-origin manual-redirect / opaque case.
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect", configurable: true });
    Object.defineProperty(opaque, "status", { value: 0, configurable: true });
    fetchMock.mockResolvedValue(opaque);
    const r = await call("https://api.example.com/x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/opaque redirect/);
  });

  it("rejects a status-0 response instead of constructing an invalid Response", async () => {
    withNetwork(["api.example.com"]);
    const failed = new Response(null, { status: 200 });
    Object.defineProperty(failed, "status", { value: 0, configurable: true });
    fetchMock.mockResolvedValue(failed);
    const r = await call("https://api.example.com/x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/status 0/);
  });

  it("round-trips a binary response body", async () => {
    withNetwork(["api.example.com"]);
    const bytes = new Uint8Array([1, 2, 3, 250]).buffer;
    fetchMock.mockResolvedValue(res(bytes, { headers: { "content-type": "application/octet-stream" } }));
    const r = await call("https://api.example.com/blob");
    expect(Array.from(resultBytes(r.result))).toEqual([1, 2, 3, 250]);
  });

  it("base64-decodes a binary request body (bodyB64) before sending", async () => {
    withNetwork(["api.example.com"]);
    fetchMock.mockResolvedValue(res("ok"));
    const reqBytes = new Uint8Array([9, 8, 7, 200]).buffer;
    await call("https://api.example.com/x", {
      method: "POST",
      bodyB64: arrayBufferToBase64(reqBytes),
    });
    const sentBody = (fetchMock.mock.calls[0][1] as { body: ArrayBuffer }).body;
    expect(Array.from(new Uint8Array(sentBody))).toEqual([9, 8, 7, 200]);
  });

  it("forwards a string request body as-is (no base64)", async () => {
    withNetwork(["api.example.com"]);
    fetchMock.mockResolvedValue(res("ok"));
    await call("https://api.example.com/x", { method: "POST", body: "hello=1" });
    expect((fetchMock.mock.calls[0][1] as { body: unknown }).body).toBe("hello=1");
  });
});

describe("readBodyCapped", () => {
  function streamResponse(chunks: Uint8Array[]): Pick<Response, "body" | "arrayBuffer"> {
    let i = 0;
    const body = {
      getReader() {
        return {
          read: async () =>
            i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined },
          cancel: async () => {},
        };
      },
    };
    return {
      body,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Pick<Response, "body" | "arrayBuffer">;
  }

  it("returns all bytes when under the cap", async () => {
    const out = await readBodyCapped(
      streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])]),
      10,
    );
    expect(out && Array.from(out)).toEqual([1, 2, 3]);
  });

  it("returns null (overflow) and stops reading once the cap is exceeded", async () => {
    const out = await readBodyCapped(
      streamResponse([new Uint8Array(8), new Uint8Array(8)]),
      10,
    );
    expect(out).toBeNull();
  });

  it("falls back to arrayBuffer when no stream, still enforcing the cap", async () => {
    const big = { body: null, arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(20) };
    expect(await readBodyCapped(big, 10)).toBeNull();
    const ok = {
      body: null,
      arrayBuffer: async (): Promise<ArrayBuffer> => new Uint8Array([9, 9]).buffer as ArrayBuffer,
    };
    const out = await readBodyCapped(ok, 10);
    expect(out && Array.from(out)).toEqual([9, 9]);
  });
});
