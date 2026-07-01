import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";

interface RunningServer {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const { startHttpServer } = await import("../server");
  // Ephemeral port for tests
  return startHttpServer({ port: 0 });
}

describe("server e2e", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-mcp-e2e-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("serves a full OAuth flow → /mcp tools/list", async () => {
    const server = await startServer();
    try {
      // 1. Initial /mcp request → 401
      const r1 = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      expect(r1.status).toBe(401);
      const wwwAuth = r1.headers.get("www-authenticate") ?? "";
      expect(wwwAuth).toContain("resource_metadata");

      // 2. Discovery
      const rr = await fetch(`${server.baseUrl}/.well-known/oauth-protected-resource`);
      expect(rr.status).toBe(200);
      const ras = await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`);
      expect(ras.status).toBe(200);

      // 3. DCR
      const dcr = await fetch(`${server.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "E2E Test",
          redirect_uris: ["http://127.0.0.1:9999/callback"],
        }),
      });
      expect(dcr.status).toBe(201);
      const { client_id } = (await dcr.json()) as { client_id: string };

      // 4. PKCE-S256
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");

      // 5. /authorize → returns HTML with embedded code (because autoApprove).
      // Phase 2: /authorize no longer auto-approves by default; the extension
      // content script drives consent. We opt back into Phase 1 behaviour via
      // ?autoapprove=1 so the existing E2E path keeps working without an
      // extension. The real consent flow is covered end-to-end in Task 18.
      const authUrl = new URL(`${server.baseUrl}/authorize`);
      authUrl.search = new URLSearchParams({
        client_id,
        redirect_uri: "http://127.0.0.1:9999/callback",
        response_type: "code",
        scope: "list_windows read_page",
        state: "s1",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: `${server.baseUrl}/mcp`,
        autoapprove: "1",
      }).toString();
      const authResp = await fetch(authUrl);
      expect(authResp.status).toBe(200);
      const html = await authResp.text();
      const codeMatch = html.match(/code=([A-Za-z0-9_-]+)/);
      expect(codeMatch).not.toBeNull();
      const code = codeMatch![1];

      // 6. /token
      const tokenResp = await fetch(`${server.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "http://127.0.0.1:9999/callback",
          client_id,
          code_verifier: verifier,
        }).toString(),
      });
      expect(tokenResp.status).toBe(200);
      const { access_token } = (await tokenResp.json()) as { access_token: string };
      expect(typeof access_token).toBe("string");

      // 7. /mcp tools/list with bearer
      const r2 = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(r2.status).toBe(200);
      const body = (await r2.json()) as { result: { tools: { name: string }[] } };
      expect(body.result.tools.map((t) => t.name).sort()).toEqual(
        ["cancel_task", "get_context", "list_spaces", "list_windows", "open_url", "read_page", "screenshot", "task", "task_status", "task_wait"].sort(),
      );
    } finally {
      await server.close();
    }
  });
});
