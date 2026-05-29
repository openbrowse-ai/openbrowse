import { McpClient } from "@/lib/mcp/client";
import type {
  McpServerConfig,
  McpServerState,
  McpToolInfo,
} from "@/lib/mcp/types";

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

    const client = new McpClient(config);
    const state: McpServerState = {
      config,
      status: "connecting",
      tools: [],
      resources: [],
      prompts: [],
    };
    this.connections.set(config.id, { client, state });
    this.broadcastStateChange();

    try {
      await client.connect();
      const [tools, resources, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);
      state.status = "connected";
      state.tools = tools;
      state.resources = resources;
      state.prompts = prompts;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("401") || message.includes("Unauthorized")) {
        state.status = "auth_required";
        state.error = "Authorization required";
      } else {
        state.status = "error";
        state.error = message;
      }
    }
    this.broadcastStateChange();
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
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`Server ${serverId} not connected`);
    return conn.client.callTool(toolName, args);
  }

  async readResource(serverId: string, uri: string): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`Server ${serverId} not connected`);
    return conn.client.readResource(uri);
  }

  async getPrompt(serverId: string, promptName: string, args?: Record<string, string>): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`Server ${serverId} not connected`);
    return conn.client.getPrompt(promptName, args);
  }

  getClient(serverId: string): McpClient | undefined {
    return this.connections.get(serverId)?.client;
  }

  private broadcastStateChange() {
    chrome.runtime.sendMessage({ type: "MCP_STATE_CHANGED", states: this.getStates() }).catch(() => {});
  }
}

export const backgroundMcpRegistry = new BackgroundMcpRegistry();
