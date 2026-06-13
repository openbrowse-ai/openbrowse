import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the MCP OAuth token-lifecycle helpers that stop connectors from
 * requiring re-authorization after an extension update. The fix captures a
 * refresh token + expiry at exchange time and uses it to silently mint a new
 * access token when the stored one has expired (the post-update reconnect).
 */

let store: Record<string, unknown>;

function installChromeStub() {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: (key?: string | string[]) => {
          if (typeof key === "string")
            return Promise.resolve({ [key]: store[key] });
          return Promise.resolve({ ...store });
        },
        set: (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
          return Promise.resolve();
        },
      },
    },
  });
}

function seedServer(auth: Record<string, unknown>) {
  store["settings"] = {
    mcpServers: [
      {
        id: "srv1",
        name: "Srv",
        url: "https://mcp.example/sse",
        enabled: true,
        auth: { type: "oauth", ...auth },
      },
    ],
  };
}

function storedAuth() {
  const settings = store["settings"] as {
    mcpServers: { id: string; auth: Record<string, unknown> }[];
  };
  return settings.mcpServers[0].auth;
}

describe("tokenIsExpiring", () => {
  beforeEach(() => installChromeStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns false when no expiresAt is known", async () => {
    const { tokenIsExpiring } = await import("../mcp-oauth");
    expect(tokenIsExpiring({ type: "oauth", token: "t" })).toBe(false);
  });

  it("returns true when the token is already expired", async () => {
    const { tokenIsExpiring } = await import("../mcp-oauth");
    expect(
      tokenIsExpiring({ type: "oauth", token: "t", expiresAt: Date.now() - 1000 }),
    ).toBe(true);
  });

  it("returns true within the skew window before expiry", async () => {
    const { tokenIsExpiring } = await import("../mcp-oauth");
    // Expires in 30s, default skew is 60s → considered expiring.
    expect(
      tokenIsExpiring({
        type: "oauth",
        token: "t",
        expiresAt: Date.now() + 30_000,
      }),
    ).toBe(true);
  });

  it("returns false when comfortably before expiry", async () => {
    const { tokenIsExpiring } = await import("../mcp-oauth");
    expect(
      tokenIsExpiring({
        type: "oauth",
        token: "t",
        expiresAt: Date.now() + 10 * 60_000,
      }),
    ).toBe(false);
  });
});

describe("authPatchFromTokenResponse", () => {
  beforeEach(() => installChromeStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("captures access token, refresh token, expiry and scope", async () => {
    const { authPatchFromTokenResponse } = await import("../mcp-oauth");
    const before = Date.now();
    const patch = authPatchFromTokenResponse(
      {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        scope: "read write",
      },
      { tokenEndpoint: "https://auth.example/token" },
    );
    expect(patch.token).toBe("at");
    expect(patch.refreshToken).toBe("rt");
    expect(patch.tokenEndpoint).toBe("https://auth.example/token");
    expect(patch.scope).toBe("read write");
    expect(patch.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it("falls back to the extra scope when the response omits it", async () => {
    const { authPatchFromTokenResponse } = await import("../mcp-oauth");
    const patch = authPatchFromTokenResponse(
      { access_token: "at" },
      { scope: "offline_access read" },
    );
    expect(patch.scope).toBe("offline_access read");
    expect(patch.expiresAt).toBeUndefined();
    expect(patch.refreshToken).toBeUndefined();
  });
});

describe("refreshAccessToken", () => {
  beforeEach(() => installChromeStub());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns null when there is no refresh token", async () => {
    seedServer({ token: "old", tokenEndpoint: "https://auth.example/token" });
    const { refreshAccessToken } = await import("../mcp-oauth");
    expect(await refreshAccessToken("srv1")).toBeNull();
  });

  it("returns null when there is no token endpoint", async () => {
    seedServer({ token: "old", refreshToken: "rt" });
    const { refreshAccessToken } = await import("../mcp-oauth");
    expect(await refreshAccessToken("srv1")).toBeNull();
  });

  it("exchanges the refresh token and persists the rotated token + expiry", async () => {
    seedServer({
      token: "old",
      refreshToken: "rt-old",
      tokenEndpoint: "https://auth.example/token",
      clientId: "cid",
      scope: "read",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "new-at",
        refresh_token: "rt-new",
        expires_in: 7200,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { refreshAccessToken } = await import("../mcp-oauth");
    const token = await refreshAccessToken("srv1");
    expect(token).toBe("new-at");

    // Correct grant + params sent.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://auth.example/token");
    const body = (init.body as URLSearchParams).toString();
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt-old");
    expect(body).toContain("client_id=cid");

    // Persisted rotation.
    const auth = storedAuth();
    expect(auth.token).toBe("new-at");
    expect(auth.refreshToken).toBe("rt-new");
    expect(auth.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns null and leaves auth intact when the server rejects the refresh", async () => {
    seedServer({
      token: "old",
      refreshToken: "rt-old",
      tokenEndpoint: "https://auth.example/token",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }),
    );
    const { refreshAccessToken } = await import("../mcp-oauth");
    expect(await refreshAccessToken("srv1")).toBeNull();
    expect(storedAuth().token).toBe("old");
    expect(storedAuth().refreshToken).toBe("rt-old");
  });

  it("deduplicates concurrent refreshes (single token-endpoint call)", async () => {
    seedServer({
      token: "old",
      refreshToken: "rt-old",
      tokenEndpoint: "https://auth.example/token",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-at", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { refreshAccessToken } = await import("../mcp-oauth");
    const [a, b] = await Promise.all([
      refreshAccessToken("srv1"),
      refreshAccessToken("srv1"),
    ]);
    expect(a).toBe("new-at");
    expect(b).toBe("new-at");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("isUnauthorizedError", () => {
  afterEach(() => vi.resetModules());
  it("matches 401 and Unauthorized messages", async () => {
    const { isUnauthorizedError } = await import("../mcp-oauth");
    expect(isUnauthorizedError(new Error("HTTP 401"))).toBe(true);
    expect(isUnauthorizedError(new Error("Unauthorized"))).toBe(true);
    expect(isUnauthorizedError(new Error("500 boom"))).toBe(false);
  });
});

describe("buildAuthScope", () => {
  afterEach(() => vi.resetModules());

  it("adds offline_access when the provider lists it (Attio)", async () => {
    const { buildAuthScope } = await import("../mcp-oauth");
    // Real Attio auth-server metadata shape.
    const scope = buildAuthScope({
      scopes_supported: ["mcp", "offline_access", "openid"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(scope).toBeDefined();
    expect(scope!.split(" ")).toContain("offline_access");
    expect(scope!.split(" ")).toContain("mcp");
  });

  it("adds offline_access when no scopes are declared but refresh_token grant is supported (Stripe)", async () => {
    const { buildAuthScope } = await import("../mcp-oauth");
    // Real Stripe auth-server metadata shape: no scopes_supported field.
    const scope = buildAuthScope({
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(scope).toBe("offline_access");
  });

  it("does NOT add offline_access for a granular-scope provider that omits it (Supabase)", async () => {
    const { buildAuthScope } = await import("../mcp-oauth");
    // Real Supabase metadata shape: granular scopes, no offline_access.
    const scope = buildAuthScope({
      scopes_supported: ["projects:read", "database:read"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
    expect(scope).toBe("projects:read database:read");
    expect(scope).not.toContain("offline_access");
  });

  it("returns undefined when nothing can be requested", async () => {
    const { buildAuthScope } = await import("../mcp-oauth");
    // No scopes declared and no refresh_token grant → request no scope at all
    // (don't risk an unknown-scope rejection on a strict provider).
    expect(buildAuthScope({})).toBeUndefined();
    expect(
      buildAuthScope({ grant_types_supported: ["authorization_code"] }),
    ).toBeUndefined();
  });
});
