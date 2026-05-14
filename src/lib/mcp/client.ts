import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig, McpToolInfo, McpResourceInfo, McpPromptInfo } from "./types";

export class McpClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private config: McpServerConfig;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.client = new Client(
      { name: "openbrowse", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    const headers: HeadersInit = {};
    if (this.config.auth?.token) {
      headers["Authorization"] = `Bearer ${this.config.auth.token}`;
    } else if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    try {
      this.transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
        requestInit: { headers },
      });
      await this.client.connect(this.transport);
    } catch {
      this.transport = new SSEClientTransport(new URL(this.config.url), {
        requestInit: { headers },
      });
      await this.client.connect(this.transport);
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      serverId: this.config.id,
      serverName: this.config.name,
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const content = result.content as Array<{ type: string; text?: string }> | undefined;
      throw new Error(
        content
          ?.map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
          .join("\n") ?? "MCP tool call failed",
      );
    }
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    return content?.map((c) => (c.type === "text" ? c.text : c)).join("\n") ?? "";
  }

  async listResources(): Promise<McpResourceInfo[]> {
    try {
      const result = await this.client.listResources();
      return result.resources.map((r) => ({
        serverId: this.config.id,
        serverName: this.config.name,
        uri: r.uri,
        name: r.name,
        description: r.description ?? "",
        mimeType: r.mimeType,
      }));
    } catch {
      return [];
    }
  }

  async readResource(uri: string): Promise<string> {
    const result = await this.client.readResource({ uri });
    const content = result.contents as Array<{ type?: string; uri: string; text?: string; blob?: string }>;
    return content.map((c) => c.text ?? "").join("\n");
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    try {
      const result = await this.client.listPrompts();
      return result.prompts.map((p) => ({
        serverId: this.config.id,
        serverName: this.config.name,
        name: p.name,
        description: p.description ?? "",
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      }));
    } catch {
      return [];
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<string> {
    const result = await this.client.getPrompt({ name, arguments: args });
    const messages = result.messages as Array<{ role: string; content: { type: string; text?: string } }>;
    return messages.map((m) => m.content.text ?? "").join("\n");
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // already closed
    }
    this.transport = null;
  }
}
