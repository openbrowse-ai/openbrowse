import type { McpServerConfig, McpServerState, McpToolInfo } from "./types";

export type McpMessage =
  | { type: "MCP_CONNECT_ALL"; configs: McpServerConfig[] }
  | { type: "MCP_CONNECT_SERVER"; config: McpServerConfig }
  | { type: "MCP_DISCONNECT_SERVER"; serverId: string }
  | { type: "MCP_DISCONNECT_ALL" }
  | { type: "MCP_GET_STATES" }
  | { type: "MCP_GET_TOOLS" }
  | { type: "MCP_CALL_TOOL"; serverId: string; toolName: string; args: Record<string, unknown> }
  | { type: "MCP_READ_RESOURCE"; serverId: string; uri: string }
  | { type: "MCP_GET_PROMPT"; serverId: string; promptName: string; args?: Record<string, string> }
  | { type: "MCP_OAUTH_START"; serverId: string; serverConfig?: McpServerConfig };

export type McpStatesResponse = { ok: true; states: McpServerState[] } | { ok: false; error: string };
export type McpToolsResponse = { ok: true; tools: McpToolInfo[] } | { ok: false; error: string };
export type McpResultResponse = { ok: true; result: unknown } | { ok: false; error: string };

export type McpResponse =
  | { ok: true; states: McpServerState[] }
  | { ok: true; tools: McpToolInfo[] }
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export function sendMcpMessage(message: { type: "MCP_GET_STATES" }): Promise<McpStatesResponse>;
export function sendMcpMessage(message: { type: "MCP_CONNECT_ALL"; configs: McpServerConfig[] }): Promise<McpStatesResponse>;
export function sendMcpMessage(message: { type: "MCP_GET_TOOLS" }): Promise<McpToolsResponse>;
export function sendMcpMessage(message: { type: "MCP_CALL_TOOL"; serverId: string; toolName: string; args: Record<string, unknown> }): Promise<McpResultResponse>;
export function sendMcpMessage(message: { type: "MCP_READ_RESOURCE"; serverId: string; uri: string }): Promise<McpResultResponse>;
export function sendMcpMessage(message: { type: "MCP_GET_PROMPT"; serverId: string; promptName: string; args?: Record<string, string> }): Promise<McpResultResponse>;
export function sendMcpMessage(message: McpMessage): Promise<McpResponse>;
export function sendMcpMessage(message: McpMessage): Promise<McpResponse> {
  return chrome.runtime.sendMessage(message);
}
