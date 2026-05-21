import { tool, type ToolSet } from "ai";
import { sendMcpMessage } from "./messages";
import { jsonSchemaToZod } from "./schema-to-zod";
import type { McpServerConfig, McpServerState, McpToolInfo } from "./types";

export class McpRegistry {
  private cachedStates: McpServerState[] = [];
  private cachedTools: McpToolInfo[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "MCP_STATE_CHANGED") {
        this.cachedStates = message.states;
        this.cachedTools = this.cachedStates
          .filter((s) => s.status === "connected")
          .flatMap((s) => s.tools);
        this.notify();
      }
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  getStates(): McpServerState[] {
    return this.cachedStates;
  }

  getAllTools(): McpToolInfo[] {
    return this.cachedTools;
  }

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    const response = await sendMcpMessage({ type: "MCP_CONNECT_ALL", configs });
    if (response?.ok && "states" in response) {
      this.cachedStates = response.states;
      this.cachedTools = this.cachedStates
        .filter((s) => s.status === "connected")
        .flatMap((s) => s.tools);
      this.notify();
    }
  }

  async disconnectAll(): Promise<void> {
    await sendMcpMessage({ type: "MCP_DISCONNECT_ALL" });
    this.cachedStates = [];
    this.cachedTools = [];
    this.notify();
  }

  async refreshStates(): Promise<void> {
    const response = await sendMcpMessage({ type: "MCP_GET_STATES" });
    if (response?.ok && "states" in response) {
      this.cachedStates = response.states;
      this.cachedTools = this.cachedStates
        .filter((s) => s.status === "connected")
        .flatMap((s) => s.tools);
      this.notify();
    }
  }

  toSDKTools(): ToolSet {
    const sdkTools: ToolSet = {};

    for (const state of this.cachedStates) {
      if (state.status !== "connected") continue;
      const permissions = state.config.toolPermissions ?? {};

      for (const mcpTool of state.tools) {
        const permission = permissions[mcpTool.name] ?? "allowed";
        if (permission === "disabled") continue;

        const toolKey = `mcp_${mcpTool.serverId}_${mcpTool.name}`;
        const zodSchema = jsonSchemaToZod(mcpTool.inputSchema);

        sdkTools[toolKey] = tool({
          description: `[${mcpTool.serverName}] ${mcpTool.description}`,
          inputSchema: zodSchema,
          needsApproval: permission === "approval",
          execute: async (input) => {
            const response = await sendMcpMessage({
              type: "MCP_CALL_TOOL",
              serverId: mcpTool.serverId,
              toolName: mcpTool.name,
              args: input as Record<string, unknown>,
            });
            if (!response.ok) throw new Error(response.error);
            return response.result;
          },
        });
      }
    }

    return sdkTools;
  }
}

let globalRegistry: McpRegistry | null = null;

export function getMcpRegistry(): McpRegistry {
  if (!globalRegistry) {
    globalRegistry = new McpRegistry();
  }
  return globalRegistry;
}
