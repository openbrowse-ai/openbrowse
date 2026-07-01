import { describe, expect, it } from "vitest";

describe("routes/well-known", () => {
  it("oauth-protected-resource lists localhost issuer as AS", async () => {
    const { wellKnownProtectedResource } = await import("../well-known");
    const cfg = { port: 47821, issuer: "http://localhost:47821", resource: "http://localhost:47821/mcp" };
    const body = wellKnownProtectedResource(cfg);
    expect(body.resource).toBe("http://localhost:47821/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost:47821"]);
    expect(body.scopes_supported).toContain("read_page");
    expect(body.bearer_methods_supported).toContain("header");
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("oauth-authorization-server lists endpoints and PKCE-S256", async () => {
    const { wellKnownAuthorizationServer } = await import("../well-known");
    const cfg = { port: 47821, issuer: "http://localhost:47821", resource: "http://localhost:47821/mcp" };
    const body = wellKnownAuthorizationServer(cfg);
    expect(body.issuer).toBe("http://localhost:47821");
    expect(body.authorization_endpoint).toBe("http://localhost:47821/authorize");
    expect(body.token_endpoint).toBe("http://localhost:47821/token");
    expect(body.registration_endpoint).toBe("http://localhost:47821/register");
    expect(body.jwks_uri).toBe("http://localhost:47821/jwks");
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.scopes_supported).toEqual([
      "task", "read_page", "screenshot", "list_windows", "list_spaces", "open_url",
    ]);
  });
});
