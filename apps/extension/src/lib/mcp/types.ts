export type McpToolPermission = "allowed" | "approval" | "disabled";

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  apiKey?: string;
  enabled: boolean;
  auth?: McpAuthConfig;
  toolPermissions?: Record<string, McpToolPermission>;
}

export interface McpAuthConfig {
  type: "bearer" | "oauth";
  token?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceInfo {
  serverId: string;
  serverName: string;
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "auth_required"
  | "error";

export interface McpServerState {
  config: McpServerConfig;
  status: McpConnectionStatus;
  tools: McpToolInfo[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
  error?: string;
}
