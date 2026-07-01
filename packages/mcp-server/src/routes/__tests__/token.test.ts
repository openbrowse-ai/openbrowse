import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function setup() {
  const { handleToken } = await import("../token");
  const { createCodeStore } = await import("../../oauth/codes");
  const { createClientRegistry } = await import("../../oauth/clients");
  const { createRefreshTokenStore } = await import("../../oauth/refresh-tokens");
  const { mintJwt, verifyJwt } = await import("../../oauth/jwt");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const codes = createCodeStore();
  const clients = createClientRegistry();
  const refreshTokens = await createRefreshTokenStore();
  const reg = clients.register({
    client_name: "TestApp",
    redirect_uris: ["http://127.0.0.1:9999/cb"],
  });
  if (!reg.ok) throw new Error("setup failed");

  return {
    handleToken,
    codes,
    clients,
    refreshTokens,
    client: reg.client,
    privateKey,
    publicKey,
    cfg: {
      port: 47821,
      issuer: "http://localhost:47821",
      resource: "http://localhost:47821/mcp",
    },
    mintJwt,
    verifyJwt,
  };
}

function mintCode(codes: Awaited<ReturnType<typeof setup>>["codes"], client_id: string, verifier: string) {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return codes.issue({
    client_id,
    redirect_uri: "http://127.0.0.1:9999/cb",
    scope: "task read_page",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "http://localhost:47821/mcp",
    state: "s1",
  });
}

describe("routes/token", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-token-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("exchanges valid code+verifier for an access token", async () => {
    const t = await setup();
    const verifier = "verifier_value_that_is_long_enough_for_PKCE";
    const code = mintCode(t.codes, t.client.client_id, verifier);

    const result = t.handleToken({
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9999/cb",
        client_id: t.client.client_id,
        code_verifier: verifier,
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });

    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("access_token");
    const verified = t.verifyJwt(result.body.access_token as string, t.publicKey, {
      audience: t.cfg.resource,
    });
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.payload.sub).toBe(t.client.client_id);
      expect(verified.payload.scope).toBe("task read_page");
      expect(verified.payload.client_name).toBe("TestApp");
    }
  });

  it("issues a refresh_token alongside access_token on authorization_code exchange", async () => {
    const t = await setup();
    const verifier = "verifier_value_that_is_long_enough_for_PKCE";
    const code = mintCode(t.codes, t.client.client_id, verifier);

    const result = t.handleToken({
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9999/cb",
        client_id: t.client.client_id,
        code_verifier: verifier,
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });

    expect(result.status).toBe(200);
    expect(typeof result.body.refresh_token).toBe("string");
    expect((result.body.refresh_token as string).length).toBeGreaterThan(20);
  });

  it("redeems a refresh_token, rotating to a new one", async () => {
    const t = await setup();
    const verifier = "verifier_value_that_is_long_enough_for_PKCE";
    const code = mintCode(t.codes, t.client.client_id, verifier);

    const first = t.handleToken({
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9999/cb",
        client_id: t.client.client_id,
        code_verifier: verifier,
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });
    expect(first.status).toBe(200);
    const oldToken = first.body.refresh_token as string;
    expect(typeof oldToken).toBe("string");

    const r2 = t.handleToken({
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oldToken,
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });
    expect(r2.status).toBe(200);
    expect(typeof r2.body.access_token).toBe("string");
    expect(r2.body.refresh_token).not.toBe(oldToken);
    expect(typeof r2.body.refresh_token).toBe("string");

    // The new access token should be valid and carry the client_id from the
    // refresh-token entry.
    const verified = t.verifyJwt(r2.body.access_token as string, t.publicKey, {
      audience: t.cfg.resource,
    });
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.payload.sub).toBe(t.client.client_id);
      expect(verified.payload.scope).toBe("task read_page");
    }

    // Old refresh token rejected on second use (rotation)
    const r3 = t.handleToken({
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oldToken,
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });
    expect(r3.status).toBe(400);
    expect(r3.body).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects unsupported grant_type", async () => {
    const t = await setup();
    const result = t.handleToken({
      body: new URLSearchParams({ grant_type: "password" }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("rejects unknown code", async () => {
    const t = await setup();
    const result = t.handleToken({
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "nonexistent",
        redirect_uri: "http://127.0.0.1:9999/cb",
        client_id: t.client.client_id,
        code_verifier: "v",
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects bad PKCE verifier", async () => {
    const t = await setup();
    const code = mintCode(t.codes, t.client.client_id, "actual_verifier");
    const result = t.handleToken({
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9999/cb",
        client_id: t.client.client_id,
        code_verifier: "wrong_verifier",
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: "invalid_grant" });
  });

  it("rejects reuse of a redeemed code", async () => {
    const t = await setup();
    const verifier = "v123456789012345678901234567890";
    const code = mintCode(t.codes, t.client.client_id, verifier);

    const first = t.handleToken({
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9999/cb",
        client_id: t.client.client_id,
        code_verifier: verifier,
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });
    expect(first.status).toBe(200);

    const second = t.handleToken({
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9999/cb",
        client_id: t.client.client_id,
        code_verifier: verifier,
      }),
      codes: t.codes,
      clients: t.clients,
      refreshTokens: t.refreshTokens,
      privateKey: t.privateKey,
      kid: "kid1",
      cfg: t.cfg,
    });
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ error: "invalid_grant" });
  });
});
