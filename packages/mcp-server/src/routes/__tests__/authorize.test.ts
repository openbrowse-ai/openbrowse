import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("routes/authorize", () => {
  let tmpHome: string;
  beforeEach(() => {
    // The client registry persists to $HOME/.openbrowse — isolate each test.
    tmpHome = mkdtempSync(join(tmpdir(), "obx-authz-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("validates client, mints a code, and returns an HTML page with auto-redirect", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({
      client_name: "TestApp",
      redirect_uris: ["http://127.0.0.1:9999/cb"],
    });
    if (!reg.ok) throw new Error("setup");
    const pending = createPendingConsents();
    const codes = createCodeStore();

    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        response_type: "code",
        scope: "task read_page",
        state: "s1",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "http://localhost:47821/mcp",
      },
      clients,
      pending,
      codes,
    });
    expect(result.kind).toBe("html");
    if (result.kind === "html") {
      expect(result.body).toContain("TestApp");
      expect(result.body).toContain("task");
      expect(result.body).toContain("read_page");
      // contains the JS auto-redirect (Phase 1 behaviour matching spike)
      expect(result.body).toMatch(/window\.location\.replace/);
      // The redirect URL must contain the code so the host's callback can use it
      expect(result.body).toContain("code=");
      expect(result.body).toContain("state=s1");
      // Phase 2: emit data-redirect-url for the extension content script
      expect(result.body).toContain("data-redirect-url=");
    }
    expect(pending.find("s1")).toBeDefined();
  });

  it("HTML-escapes client_name to prevent XSS", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({
      client_name: `<script>alert('xss')</script>`,
      redirect_uris: ["http://127.0.0.1:9999/cb"],
    });
    if (!reg.ok) throw new Error("setup");
    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("html");
    if (result.kind === "html") {
      expect(result.body).not.toContain("<script>alert('xss')</script>");
      expect(result.body).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    }
  });

  it("unknown client_id with a non-loopback redirect_uri renders a recovery page (no redirect)", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const pending = createPendingConsents();
    const codes = createCodeStore();

    const result = handleAuthorize({
      params: {
        // XSS-shaped client_id: the recovery page interpolates the id into
        // HTML, so this doubles as escaping coverage for that code path.
        client_id: "<script>alert('xss')</script>",
        redirect_uri: "https://evil.example.com/cb",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending,
      codes,
    });
    // RFC 6749 §4.1.2.1: MUST NOT redirect to an unvalidated redirect_uri.
    expect(result.kind).toBe("error_page");
    if (result.kind === "error_page") {
      expect(result.status).toBe(400);
      expect(result.body).toContain("re-authenticate");
      // client_id is rendered escaped, never as live markup.
      expect(result.body).not.toContain("<script>alert");
      expect(result.body).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    }
  });

  it("unknown client_id with a loopback redirect_uri redirects with error=invalid_client", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();

    const result = handleAuthorize({
      params: {
        client_id: "stale_id_from_before_restart",
        redirect_uri: "http://127.0.0.1:33418/callback",
        response_type: "code",
        scope: "task",
        state: "xyz",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("redirect");
    if (result.kind === "redirect") {
      const loc = new URL(result.location);
      expect(loc.origin).toBe("http://127.0.0.1:33418");
      expect(loc.pathname).toBe("/callback");
      expect(loc.searchParams.get("error")).toBe("invalid_client");
      // The description is the host-facing recovery hint — assert it survives.
      expect(loc.searchParams.get("error_description")).toMatch(/re-register/i);
      expect(loc.searchParams.get("state")).toBe("xyz");
    }
  });

  it("unknown client_id with an HTTPS localhost redirect_uri does NOT redirect (http-only loopback rule)", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");

    const result = handleAuthorize({
      params: {
        client_id: "nonexistent",
        redirect_uri: "https://localhost:8443/cb",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients: createClientRegistry(),
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("error_page");
  });

  it("successful authorize touches the client's last_used_at (LRU bookkeeping)", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({ redirect_uris: ["http://127.0.0.1:9999/cb"] });
    if (!reg.ok) throw new Error("setup");
    const before = clients.get(reg.client.client_id)!.last_used_at;

    await new Promise((r) => setTimeout(r, 5));
    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("html");
    expect(clients.get(reg.client.client_id)!.last_used_at).toBeGreaterThan(before);
  });

  it("failed authorize (bad redirect_uri) does NOT touch last_used_at", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({ redirect_uris: ["http://127.0.0.1:9999/cb"] });
    if (!reg.ok) throw new Error("setup");
    const before = clients.get(reg.client.client_id)!.last_used_at;

    await new Promise((r) => setTimeout(r, 5));
    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/WRONG",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("error");
    expect(clients.get(reg.client.client_id)!.last_used_at).toBe(before);
  });

  it("rejects unregistered redirect_uri (exact-match required)", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({ redirect_uris: ["http://127.0.0.1:9999/cb"] });
    if (!reg.ok) throw new Error("setup");

    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/wrong",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/redirect_uri/);
  });

  it("rejects non-S256 PKCE", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({ redirect_uris: ["http://127.0.0.1:9999/cb"] });
    if (!reg.ok) throw new Error("setup");

    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "plain",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/PKCE/);
  });

  it("rejects empty code_challenge", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({ redirect_uris: ["http://127.0.0.1:9999/cb"] });
    if (!reg.ok) throw new Error("setup");

    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/PKCE/);
  });

  it("rejects unsupported response_type", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({ redirect_uris: ["http://127.0.0.1:9999/cb"] });
    if (!reg.ok) throw new Error("setup");

    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        response_type: "token", // unsupported
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/response_type/);
  });

  it("autoApprove=false omits the window.location.replace script", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const reg = clients.register({
      client_name: "TestApp",
      redirect_uris: ["http://127.0.0.1:9999/cb"],
    });
    if (!reg.ok) throw new Error("setup");
    const result = handleAuthorize({
      params: {
        client_id: reg.client.client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        response_type: "code",
        scope: "task",
        state: "s",
        code_challenge: "ch",
        code_challenge_method: "S256",
        resource: "r",
      },
      clients,
      pending: createPendingConsents(),
      codes: createCodeStore(),
      autoApprove: false,
    });
    expect(result.kind).toBe("html");
    if (result.kind === "html") {
      // Phase 2: no auto-redirect — the extension content script drives consent.
      expect(result.body).not.toMatch(/window\.location\.replace/);
      // Still emits the data block so the content script can read params.
      expect(result.body).toContain("data-openbrowse-authorize");
    }
  });
});
