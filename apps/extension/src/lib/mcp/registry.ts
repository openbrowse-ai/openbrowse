import { tool, type ToolSet } from "ai";
import { isServiceWorkerContext } from "@/lib/runtime/context";
import { sendMcpMessage } from "./messages";
import { jsonSchemaToZod } from "./schema-to-zod";
import type { McpServerConfig, McpServerState, McpToolInfo } from "./types";

export class McpRegistry {
  private cachedStates: McpServerState[] = [];
  private cachedTools: McpToolInfo[] = [];
  private listeners = new Set<() => void>();
  // Lazily resolved when running in the SW realm; gives `getStates()`
  // and `getAllTools()` a direct read path so the agent loop never sees
  // stale empty arrays. See SkillsRegistry for the same pattern.
  private bgRegistry: {
    getStates: () => McpServerState[];
    getAllTools: () => McpToolInfo[];
  } | null = null;
  private bgInitPromise: Promise<void> | null = null;

  constructor() {
    // SW realm: `chrome.runtime.sendMessage` doesn't echo to sender, so
    // a renderer-style MCP_STATE_CHANGED listener here would never fire.
    // Skip and rely on the live `backgroundMcpRegistry` read path below.
    if (!isServiceWorkerContext()) {
      try {
        chrome.runtime.onMessage.addListener((message) => {
          if (message.type === "MCP_STATE_CHANGED") {
            this.cachedStates = message.states;
            this.cachedTools = this.cachedStates
              .filter((s) => s.status === "connected")
              .flatMap((s) => s.tools);
            this.notify();
          }
        });
      } catch {
        // Test / non-extension context; ignore.
      }
    } else {
      // Eagerly resolve the bg registry reference so the very first
      // `getStates()` after an SW restart sees live data instead of the
      // empty default cache.
      this.bgInitPromise = (async () => {
        try {
          const mod = await import("@/entrypoints/background/mcp-registry");
          this.bgRegistry = mod.backgroundMcpRegistry;
        } catch {
          // SW-only module unavailable (test harness); leave null.
        }
      })();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  getStates(): McpServerState[] {
    if (this.bgRegistry) return this.bgRegistry.getStates();
    return this.cachedStates;
  }

  getAllTools(): McpToolInfo[] {
    if (this.bgRegistry) return this.bgRegistry.getAllTools();
    return this.cachedTools;
  }

  /** Resolves when the SW-realm direct bridge has loaded (no-op elsewhere). */
  async ready(): Promise<void> {
    if (this.bgInitPromise) await this.bgInitPromise;
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
    // Read live in SW realm so a server that connected after this
    // singleton was first constructed still shows up.
    const states = this.bgRegistry
      ? this.bgRegistry.getStates()
      : this.cachedStates;

    for (const state of states) {
      if (state.status !== "connected") continue;
      const permissions = state.config.toolPermissions ?? {};

      for (const mcpTool of state.tools) {
        const permission = permissions[mcpTool.name] ?? "allowed";
        if (permission === "disabled") continue;

        const toolKey = `mcp_${mcpTool.serverId}_${mcpTool.name}`;
        // jsonSchemaToZod handles undefined / malformed inputSchema by
        // returning `z.object({}).passthrough()` — which still enforces
        // the top-level object invariant required by Anthropic
        // (`tool_use.input` must be a dictionary), so a server that
        // forgot to declare an inputSchema still produces a valid tool
        // surface that rejects non-object inputs structurally.
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
