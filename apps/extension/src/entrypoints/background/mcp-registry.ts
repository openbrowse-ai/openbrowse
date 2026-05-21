import { McpClient } from "@/lib/mcp/client";
import type {
  McpServerConfig,
  McpServerState,
  McpToolInfo,
} from "@/lib/mcp/types";

class BackgroundMcpRegistry {
  private connections = new Map<string, { client: McpClient; state: McpServerState }>();

  getStates(): McpServerState[] {
    return Array.from(this.connections.values()).map((c) => ({ ...c.state }));
  }

  async connectServer(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.id)) {
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
