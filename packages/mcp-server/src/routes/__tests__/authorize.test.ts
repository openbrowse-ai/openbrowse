import { describe, expect, it } from "vitest";

describe("routes/authorize", () => {
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

  it("rejects unknown client_id", async () => {
    const { handleAuthorize } = await import("../authorize");
    const { createClientRegistry } = await import("../../oauth/clients");
    const { createPendingConsents } = await import("../../oauth/pending-consents");
    const { createCodeStore } = await import("../../oauth/codes");
    const clients = createClientRegistry();
    const pending = createPendingConsents();
    const codes = createCodeStore();

    const result = handleAuthorize({
      params: {
        client_id: "nonexistent",
        redirect_uri: "x",
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
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/Unknown client/);
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
