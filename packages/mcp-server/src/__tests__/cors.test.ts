import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("server CORS policy", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "obx-cors-"));
    vi.stubEnv("HOME", tmpHome);
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("/.well-known/* responds with Allow-Origin: *", async () => {
    const { startHttpServer } = await import("../server");
    const s = await startHttpServer({ port: 0 });
    try {
      const r = await fetch(`${s.baseUrl}/.well-known/oauth-authorization-server`, {
        headers: { Origin: "https://attacker.example" },
      });
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      await s.close();
    }
  });

  it("/mcp rejects cross-origin without explicit allowlist match", async () => {
    const { startHttpServer } = await import("../server");
    const s = await startHttpServer({ port: 0 });
    try {
      const r = await fetch(`${s.baseUrl}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(r.headers.get("access-control-allow-origin")).not.toBe(
        "https://attacker.example",
      );
    } finally {
      await s.close();
    }
  });

  it("/mcp accepts chrome-extension:// origins", async () => {
    const { startHttpServer } = await import("../server");
    const s = await startHttpServer({ port: 0 });
    try {
      const r = await fetch(`${s.baseUrl}/mcp`, {
        method: "OPTIONS",
        headers: {
          Origin: "chrome-extension://abc123fakeid",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(r.headers.get("access-control-allow-origin")).toBe(
        "chrome-extension://abc123fakeid",
      );
    } finally {
      await s.close();
    }
  });

  it("/authorize accepts loopback origins", async () => {
    const { startHttpServer } = await import("../server");
    const s = await startHttpServer({ port: 0 });
    try {
      const r = await fetch(
        `${s.baseUrl}/authorize?client_id=x&redirect_uri=y&response_type=code&scope=task&state=s&code_challenge=c&code_challenge_method=S256&resource=r`,
        {
          headers: { Origin: "http://localhost:5173" },
        },
      );
      // /authorize returns 400 (unknown client) but CORS header is set since
      // loopback origin is allowed.
      expect(r.headers.get("access-control-allow-origin")).toBe(
        "http://localhost:5173",
      );
    } finally {
      await s.close();
    }
  });

  it("/artifact/<id> rejects cross-origin without explicit allowlist match", async () => {
    const { startHttpServer } = await import("../server");
    const s = await startHttpServer({ port: 0 });
    try {
      const r = await fetch(`${s.baseUrl}/artifact/anyid`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://attacker.example",
          "Access-Control-Request-Method": "GET",
        },
      });
      expect(r.headers.get("access-control-allow-origin")).not.toBe(
        "https://attacker.example",
      );
    } finally {
      await s.close();
    }
  });

  it("/artifact/<id> accepts chrome-extension:// origins", async () => {
    const { startHttpServer } = await import("../server");
    const s = await startHttpServer({ port: 0 });
    try {
      const r = await fetch(`${s.baseUrl}/artifact/anyid`, {
        method: "OPTIONS",
        headers: {
          Origin: "chrome-extension://abc123fakeid",
          "Access-Control-Request-Method": "GET",
        },
      });
      expect(r.headers.get("access-control-allow-origin")).toBe(
        "chrome-extension://abc123fakeid",
      );
    } finally {
      await s.close();
    }
  });
});
