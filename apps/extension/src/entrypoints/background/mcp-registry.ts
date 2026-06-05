import { McpClient } from "@/lib/mcp/client";
import type {
  McpServerConfig,
  McpServerState,
  McpToolInfo,
} from "@/lib/mcp/types";
import {
  isUnauthorizedError,
  refreshAccessToken,
  tokenIsExpiring,
} from "./mcp-oauth";
import { storage } from "@/lib/storage";

/**
 * Whether two configs describe the same live connection — i.e. reconnecting
 * would produce an identical client. Only connection-establishing fields
 * matter here (url, apiKey, auth). `name`, `enabled`, and `toolPermissions`
 * are intentionally ignored: they don't require tearing down the transport.
 */
function sameConnectionConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.url === b.url &&
    a.apiKey === b.apiKey &&
    a.auth?.type === b.auth?.type &&
    a.auth?.token === b.auth?.token &&
    a.auth?.clientId === b.auth?.clientId &&
    a.auth?.clientSecret === b.auth?.clientSecret
  );
}

class BackgroundMcpRegistry {
  private connections = new Map<string, { client: McpClient; state: McpServerState }>();

  getStates(): McpServerState[] {
    return Array.from(this.connections.values()).map((c) => ({ ...c.state }));
  }

  async connectServer(config: McpServerConfig): Promise<void> {
    const existing = this.connections.get(config.id);
    if (existing) {
      // Idempotent reconnect: if the server is already connected with the
      // same connection-relevant config (url + auth + apiKey), keep the live
      // connection instead of tearing it down. Destructively reconnecting on
      // every page load (e.g. each home.html mount calling connectAll) opens
      // a multi-second window where tools drop to 0 — and any agent turn that
      // starts in that window runs with no MCP tools. Non-connection fields
      // (name, enabled, toolPermissions) are refreshed in place so permission
      // changes still apply without a reconnect.
      if (
        existing.state.status === "connected" &&
        sameConnectionConfig(existing.state.config, config)
      ) {
        existing.state.config = config;
        this.broadcastStateChange();
        return;
      }
      await this.disconnectServer(config.id);
    }

    // Proactive refresh: if the stored access token is expired/expiring and a
    // refresh token is available, mint a fresh one BEFORE connecting. This is
    // the common post-update path — the SW restarted, the stored token may
    // have aged out, and we'd rather refresh silently than 401 and fall to
    // auth_required.
    if (tokenIsExpiring(config.auth) && config.auth?.refreshToken) {
      const newToken = await refreshAccessToken(config.id);
      if (newToken) {
        config = await this.reloadConfig(config);
      }
    }

    const state: McpServerState = {
      config,
      status: "connecting",
      tools: [],
      resources: [],
      prompts: [],
    };
    const client = new McpClient(config);
    this.connections.set(config.id, { client, state });
    this.broadcastStateChange();

    try {
      await this.establish(client, state);
    } catch (err) {
      // Reactive refresh: a 401 here usually means the access token expired
      // since we last checked (or we had no expiry to check proactively).
      // If a refresh token exists, refresh once and retry with a fresh
      // client before giving up to auth_required.
      if (isUnauthorizedError(err) && config.auth?.refreshToken) {
        const newToken = await refreshAccessToken(config.id);
        if (newToken) {
          const refreshed = await this.reloadConfig(config);
          const retryClient = new McpClient(refreshed);
          state.config = refreshed;
          // Replace the dead client with the retry client.
          await client.disconnect().catch(() => {});
          this.connections.set(config.id, { client: retryClient, state });
          try {
            await this.establish(retryClient, state);
            this.broadcastStateChange();
            return;
          } catch (retryErr) {
            this.classifyConnectError(state, retryErr);
            this.broadcastStateChange();
            return;
          }
        }
      }
      this.classifyConnectError(state, err);
    }
    this.broadcastStateChange();
  }

  /** Connect a client and populate the state's tools/resources/prompts. */
  private async establish(
    client: McpClient,
    state: McpServerState,
  ): Promise<void> {
    await client.connect();
    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listPrompts(),
    ]);
    state.status = "connected";
    state.error = undefined;
    state.tools = tools;
    state.resources = resources;
    state.prompts = prompts;
  }

  /** Map a connect error onto the right terminal state. */
  private classifyConnectError(state: McpServerState, err: unknown): void {
    if (isUnauthorizedError(err)) {
      state.status = "auth_required";
      state.error = "Authorization required";
    } else {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
    }
  }

  /** Re-read a server's config from storage (after a token refresh). */
  private async reloadConfig(
    fallback: McpServerConfig,
  ): Promise<McpServerConfig> {
    try {
      const settings = await storage.getSettings();
      return settings.mcpServers.find((s) => s.id === fallback.id) ?? fallback;
    } catch {
      return fallback;
    }
  }

  async disconnectServer(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    await conn.client.disconnect();
    this.connections.delete(id);
    this.broadcastStateChange();
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.connections.keys());
    for (const id of ids) {
      await this.disconnectServer(id);
    }
  }

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    const enabled = configs.filter((c) => c.enabled);
    await Promise.allSettled(enabled.map((c) => this.connectServer(c)));
  }

  getAllTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = [];
    for (const { state } of this.connections.values()) {
      if (state.status === "connected") {
        tools.push(...state.tools);
      }
    }
    return tools;
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.withAuthRetry(serverId, (client) =>
      client.callTool(toolName, args),
    );
  }

  async readResource(serverId: string, uri: string): Promise<unknown> {
    return this.withAuthRetry(serverId, (client) => client.readResource(uri));
  }

  async getPrompt(serverId: string, promptName: string, args?: Record<string, string>): Promise<unknown> {
    return this.withAuthRetry(serverId, (client) =>
      client.getPrompt(promptName, args),
    );
  }

  /**
   * Run a live client operation, transparently refreshing the OAuth token and
   * reconnecting once if it fails with a 401. This lets a token that expires
   * mid-conversation self-heal instead of failing the tool call (and stranding
   * the connector at auth_required). If refresh isn't possible or also fails,
   * the connector is marked auth_required and the original error is rethrown.
   */
  private async withAuthRetry<T>(
    serverId: string,
    op: (client: McpClient) => Promise<T>,
  ): Promise<T> {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`Server ${serverId} not connected`);
    try {
      return await op(conn.client);
    } catch (err) {
      if (!isUnauthorizedError(err) || !conn.state.config.auth?.refreshToken) {
        throw err;
      }
      const newToken = await refreshAccessToken(serverId);
      if (!newToken) {
        conn.state.status = "auth_required";
        conn.state.error = "Authorization required";
        this.broadcastStateChange();
        throw err;
      }
      // Reconnect with the refreshed config, then retry the op once.
      const refreshed = await this.reloadConfig(conn.state.config);
      await this.connectServer(refreshed);
      const reconn = this.connections.get(serverId);
      if (!reconn || reconn.state.status !== "connected") {
        throw err;
      }
      return op(reconn.client);
    }
  }

  getClient(serverId: string): McpClient | undefined {
    return this.connections.get(serverId)?.client;
  }

  private broadcastStateChange() {
    chrome.runtime.sendMessage({ type: "MCP_STATE_CHANGED", states: this.getStates() }).catch(() => {});
  }
}

export const backgroundMcpRegistry = new BackgroundMcpRegistry();
