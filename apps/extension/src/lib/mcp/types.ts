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
  /**
   * OAuth refresh token. When present, an expired/401'd access token is
   * refreshed automatically (silently) instead of forcing a full re-auth.
   * Captured from the token response at exchange time.
   */
  refreshToken?: string;
  /** Epoch ms when the access token expires (from `expires_in`), if known. */
  expiresAt?: number;
  /** Cached token endpoint so refresh doesn't re-run OAuth discovery. */
  tokenEndpoint?: string;
  /** Granted/requested scope, replayed on refresh. */
  scope?: string;
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
