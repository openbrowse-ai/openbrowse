import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";

async function setup() {
  const { handleMcp } = await import("../mcp");
  const { mintJwt } = await import("../../oauth/jwt");
  const { createRateLimiter } = await import("../../oauth/rate-limit");
  const kp = generateKeyPairSync("ed25519");
  const cfg = {
    port: 47821,
    issuer: "http://localhost:47821",
    resource: "http://localhost:47821/mcp",
  };
  const fingerprint = createHash("sha256")
    .update(kp.publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .digest("hex")
    .slice(0, 16);
  const rateLimiter = createRateLimiter({
    readPerHour: 1000,
    taskPerHour: 1000,
    concurrentTasks: 1000,
  });
  return { handleMcp, mintJwt, kp, cfg, fingerprint, rateLimiter };
}

describe("routes/mcp", () => {
  it("returns 401 with WWW-Authenticate when no token", async () => {
    const t = await setup();
    const result = await t.handleMcp({
      method: "POST",
      headers: {},
      bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({ stub: true }),
      rateLimiter: t.rateLimiter,
    });
    expect(result.status).toBe(401);
    expect(result.headers["WWW-Authenticate"]).toContain(`resource="${t.cfg.resource}"`);
    expect(result.headers["WWW-Authenticate"]).toContain("resource_metadata");
  });

  it("returns 401 when token is malformed", async () => {
    const t = await setup();
    const result = await t.handleMcp({
      method: "POST",
      headers: { authorization: "Bearer not.a.jwt" },
      bodyText: "{}",
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({}),
      rateLimiter: t.rateLimiter,
    });
    expect(result.status).toBe(401);
  });

  it("returns 401 when token has wrong audience", async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    const wrongAud = t.mintJwt(t.kp.privateKey, t.fingerprint, {
      iss: t.cfg.issuer,
      aud: "http://other/x",
      sub: "c",
      iat: now,
      exp: now + 60,
    });
    const result = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${wrongAud}` },
      bodyText: "{}",
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({}),
      rateLimiter: t.rateLimiter,
    });
    expect(result.status).toBe(401);
  });

  it("handles initialize with a valid token", async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    const token = t.mintJwt(t.kp.privateKey, t.fingerprint, {
      iss: t.cfg.issuer,
      aud: t.cfg.resource,
      sub: "c",
      iat: now,
      exp: now + 60,
    });
    const result = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({}),
      rateLimiter: t.rateLimiter,
    });
    expect(result.status).toBe(200);
    const body = JSON.parse(result.bodyText);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities).toMatchObject({ tools: {} });
  });

  it("handles tools/list with a valid token", async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    const token = t.mintJwt(t.kp.privateKey, t.fingerprint, {
      iss: t.cfg.issuer,
      aud: t.cfg.resource,
      sub: "c",
      iat: now,
      exp: now + 60,
    });
    const result = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      bodyText: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({}),
      rateLimiter: t.rateLimiter,
    });
    expect(result.status).toBe(200);
    const body = JSON.parse(result.bodyText);
    expect(body.result.tools).toHaveLength(10);
    expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      ["cancel_task", "get_context", "list_spaces", "list_windows", "open_url", "read_page", "screenshot", "task", "task_status", "task_wait"].sort(),
    );
  });

  it("dispatches tools/call to rpcForwarder", async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    const token = t.mintJwt(t.kp.privateKey, t.fingerprint, {
      iss: t.cfg.issuer,
      aud: t.cfg.resource,
      sub: "c",
      iat: now,
      exp: now + 60,
      scope: "list_windows",
    });
    let forwardedCall: { name: string; args: unknown } | null = null;
    const result = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      bodyText: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_windows", arguments: {} },
      }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async (name, args) => {
        forwardedCall = { name, args };
        return { windows: [{ windowId: 1, focused: true, incognito: false, tabCount: 1, activeTab: null, space: null }] };
      },
      rateLimiter: t.rateLimiter,
    });
    expect(result.status).toBe(200);
    expect(forwardedCall).toEqual({ name: "list_windows", args: {} });
    const body = JSON.parse(result.bodyText);
    expect(body.result.content[0].text).toContain("windowId");
  });

  it("returns 202 for notifications/initialized (no response)", async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    const token = t.mintJwt(t.kp.privateKey, t.fingerprint, {
      iss: t.cfg.issuer,
      aud: t.cfg.resource,
      sub: "c",
      iat: now,
      exp: now + 60,
    });
    const result = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      bodyText: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({}),
      rateLimiter: t.rateLimiter,
    });
    expect(result.status).toBe(202);
  });

  it("returns rate_limited when read cap is exhausted", async () => {
    const t = await setup();
    const { createRateLimiter } = await import("../../oauth/rate-limit");
    const rl = createRateLimiter({ readPerHour: 1, taskPerHour: 10, concurrentTasks: 1 });
    const now = Math.floor(Date.now() / 1000);
    const token = t.mintJwt(t.kp.privateKey, t.fingerprint, {
      iss: t.cfg.issuer,
      aud: t.cfg.resource,
      sub: "c1",
      iat: now,
      exp: now + 60,
      scope: "read_page",
    });

    // First call ok (consumes the only read slot)
    const first = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      bodyText: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read_page", arguments: {} },
      }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({ url: "x", title: "y", format: "snapshot", content: "" }),
      rateLimiter: rl,
    });
    expect(first.status).toBe(200);
    expect(JSON.parse(first.bodyText).result).toBeDefined();

    // Second call rate-limited
    const second = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      bodyText: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_page", arguments: {} },
      }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({ url: "x", title: "y", format: "snapshot", content: "" }),
      rateLimiter: rl,
    });
    expect(second.status).toBe(200);
    const body = JSON.parse(second.bodyText);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toMatch(/rate_limited/);
  });

  it("rejects tools/call when JWT scope does not include the required scope", async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    // Mint a token with only "read_page" scope, then try to call `task`.
    const token = t.mintJwt(t.kp.privateKey, t.fingerprint, {
      iss: t.cfg.issuer,
      aud: t.cfg.resource,
      sub: "c1",
      iat: now,
      exp: now + 60,
      scope: "read_page",
    });
    const r = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      bodyText: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "task", arguments: { prompt: "hi" } },
      }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({}),
      rateLimiter: t.rateLimiter,
    });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.bodyText);
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toMatch(/insufficient_scope/);
  });

  it("rejects tools/call when JWT has no scope claim at all", async () => {
    const t = await setup();
    const now = Math.floor(Date.now() / 1000);
    const token = t.mintJwt(t.kp.privateKey, t.fingerprint, {
      iss: t.cfg.issuer,
      aud: t.cfg.resource,
      sub: "c1",
      iat: now,
      exp: now + 60,
    });
    const r = await t.handleMcp({
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      bodyText: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_windows", arguments: {} },
      }),
      cfg: t.cfg,
      publicKey: t.kp.publicKey,
      rpcForwarder: async () => ({}),
      rateLimiter: t.rateLimiter,
    });
    const body = JSON.parse(r.bodyText);
    expect(body.error.message).toMatch(/insufficient_scope/);
    expect(body.error.message).toMatch(/\(none\)/);
  });
});
