import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the background MCP registry's automatic token-refresh behavior:
 *  - proactive refresh before connecting when the stored token is expiring
 *  - reactive refresh + reconnect on a 401 during connect
 *  - reactive refresh + retry on a 401 during a live tool call
 *  - falling back to auth_required when refresh isn't possible / fails
 *
 * `McpClient` and the oauth helpers are mocked so we can drive connect/list
 * outcomes deterministically.
 */

let store: Record<string, unknown>;

// --- Mock the MCP client -----------------------------------------------------
// Each instance's behavior is programmed via `clientScript`, a queue of
// outcomes keyed by the token the client was constructed with.
const connectBehavior = new Map<string, "ok" | "401">();
const callToolBehavior = { current: "ok" as "ok" | "401" };
const constructedTokens: string[] = [];

vi.mock("@/lib/mcp/client", () => {
  return {
    McpClient: class {
      private token: string;
      constructor(config: { auth?: { token?: string } }) {
        this.token = config.auth?.token ?? "";
        constructedTokens.push(this.token);
      }
      async connect() {
        if (connectBehavior.get(this.token) === "401") {
          throw new Error("HTTP 401 Unauthorized");
        }
      }
      async listTools() {
        return [];
      }
      async listResources() {
        return [];
      }
      async listPrompts() {
        return [];
      }
      async callTool() {
        if (callToolBehavior.current === "401") {
          throw new Error("HTTP 401 Unauthorized");
        }
        return "tool-result";
      }
      async disconnect() {}
    },
  };
});

// --- Mock the oauth refresh --------------------------------------------------
const refreshResult = { current: null as string | null };
const refreshCalls = { count: 0 };

vi.mock("../mcp-oauth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    refreshAccessToken: vi.fn(async (serverId: string) => {
      refreshCalls.count++;
      const next = refreshResult.current;
      if (next) {
        // Simulate the real refresh persisting the new token into settings.
        const settings = store["settings"] as {
          mcpServers: { id: string; auth: Record<string, unknown> }[];
        };
        const srv = settings.mcpServers.find((s) => s.id === serverId);
        if (srv) {
          srv.auth = { ...srv.auth, token: next };
          connectBehavior.set(next, "ok");
        }
      }
      return next;
    }),
  };
});

function installChromeStub() {
  store = {};
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: () => Promise.resolve(),
    },
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

function makeConfig(auth: Record<string, unknown>) {
  return {
    id: "srv1",
    name: "Srv",
    url: "https://mcp.example/sse",
    enabled: true,
    auth: { type: "oauth" as const, ...auth },
  };
}

describe("BackgroundMcpRegistry token refresh", () => {
  beforeEach(() => {
    installChromeStub();
    connectBehavior.clear();
    constructedTokens.length = 0;
    callToolBehavior.current = "ok";
    refreshResult.current = null;
    refreshCalls.count = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("refreshes proactively before connecting when the token is expiring", async () => {
    seedServer({
      token: "expired",
      refreshToken: "rt",
      tokenEndpoint: "https://auth.example/token",
      expiresAt: Date.now() - 1000,
    });
    refreshResult.current = "fresh";
    // The expired token would 401; the fresh token connects.
    connectBehavior.set("expired", "401");

    const { backgroundMcpRegistry } = await import("../mcp-registry");
    await backgroundMcpRegistry.connectServer(
      makeConfig({
        token: "expired",
        refreshToken: "rt",
        tokenEndpoint: "https://auth.example/token",
        expiresAt: Date.now() - 1000,
      }),
    );

    expect(refreshCalls.count).toBe(1);
    const state = backgroundMcpRegistry.getStates().find((s) => s.config.id === "srv1");
    expect(state?.status).toBe("connected");
    // The client was (re)built with the fresh token.
    expect(constructedTokens).toContain("fresh");
  });

  it("refreshes reactively on a 401 during connect, then reconnects", async () => {
    // Not expiring (no expiresAt) so the proactive path is skipped; the 401
    // surfaces during connect and triggers reactive refresh.
    seedServer({
      token: "stale",
      refreshToken: "rt",
      tokenEndpoint: "https://auth.example/token",
    });
    refreshResult.current = "fresh";
    connectBehavior.set("stale", "401");

    const { backgroundMcpRegistry } = await import("../mcp-registry");
    await backgroundMcpRegistry.connectServer(
      makeConfig({
        token: "stale",
        refreshToken: "rt",
        tokenEndpoint: "https://auth.example/token",
      }),
    );

    expect(refreshCalls.count).toBe(1);
    const state = backgroundMcpRegistry.getStates().find((s) => s.config.id === "srv1");
    expect(state?.status).toBe("connected");
  });

  it("falls back to auth_required when a 401 occurs and refresh fails", async () => {
    seedServer({
      token: "stale",
      refreshToken: "rt",
      tokenEndpoint: "https://auth.example/token",
    });
    refreshResult.current = null; // refresh fails
    connectBehavior.set("stale", "401");

    const { backgroundMcpRegistry } = await import("../mcp-registry");
    await backgroundMcpRegistry.connectServer(
      makeConfig({
        token: "stale",
        refreshToken: "rt",
        tokenEndpoint: "https://auth.example/token",
      }),
    );

    const state = backgroundMcpRegistry.getStates().find((s) => s.config.id === "srv1");
    expect(state?.status).toBe("auth_required");
  });

  it("marks auth_required on a 401 when there is no refresh token", async () => {
    seedServer({ token: "stale" });
    connectBehavior.set("stale", "401");

    const { backgroundMcpRegistry } = await import("../mcp-registry");
    await backgroundMcpRegistry.connectServer(makeConfig({ token: "stale" }));

    expect(refreshCalls.count).toBe(0);
    const state = backgroundMcpRegistry.getStates().find((s) => s.config.id === "srv1");
    expect(state?.status).toBe("auth_required");
  });

  it("retries a live tool call once after refreshing on a 401", async () => {
    seedServer({
      token: "stale",
      refreshToken: "rt",
      tokenEndpoint: "https://auth.example/token",
    });
    // Connect succeeds initially.
    connectBehavior.set("stale", "ok");
    const { backgroundMcpRegistry } = await import("../mcp-registry");
    await backgroundMcpRegistry.connectServer(
      makeConfig({
        token: "stale",
        refreshToken: "rt",
        tokenEndpoint: "https://auth.example/token",
      }),
    );

    // Now the token expires mid-session: tool call 401s, refresh yields a
    // fresh token, reconnect + retry succeeds.
    callToolBehavior.current = "401";
    refreshResult.current = "fresh";
    // After refresh+reconnect, the retried call should succeed. The mock's
    // callTool reads a shared flag, so flip it back to ok once refresh runs.
    const { refreshAccessToken } = await import("../mcp-oauth");
    (refreshAccessToken as unknown as { mockImplementation: (f: (id: string) => Promise<string | null>) => void }).mockImplementation(
      async (serverId: string) => {
        refreshCalls.count++;
        const settings = store["settings"] as {
          mcpServers: { id: string; auth: Record<string, unknown> }[];
        };
        const srv = settings.mcpServers.find((s) => s.id === serverId);
        if (srv) {
          srv.auth = { ...srv.auth, token: "fresh" };
          connectBehavior.set("fresh", "ok");
        }
        callToolBehavior.current = "ok";
        return "fresh";
      },
    );

    const result = await backgroundMcpRegistry.callTool("srv1", "doThing", {});
    expect(result).toBe("tool-result");
    expect(refreshCalls.count).toBeGreaterThanOrEqual(1);
  });
});
