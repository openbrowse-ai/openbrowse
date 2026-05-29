import { definition as supabase } from "./supabase";
import { definition as linear } from "./linear";
import { definition as notion } from "./notion";
import { definition as slack } from "./slack";
import { definition as github } from "./github";
import { definition as stripe } from "./stripe";
import { definition as vercel } from "./vercel";
import { definition as sentry } from "./sentry";
import { definition as attio } from "./attio";
import type { ConnectorDefinition } from "./types";

export const connectors: ConnectorDefinition[] = [
  supabase,
  linear,
  notion,
  slack,
  github,
  stripe,
  vercel,
  sentry,
  attio,
];

export function getConnector(id: string): ConnectorDefinition | undefined {
  return connectors.find((c) => c.id === id);
}

export function getConnectorForMcpTool(toolKey: string, serverUrl?: string): { connector: ConnectorDefinition; toolName: string } | null {
  const match = toolKey.match(/^mcp_([^_]+)_(.+)$/);
  if (!match) return null;
  const serverId = match[1];
  const toolName = match[2];
  const connector = connectors.find((c) => c.id === serverId) ??
    (serverUrl ? connectors.find((c) => c.url === serverUrl) : null);
  if (!connector) return null;
  return { connector, toolName };
}

export type { ConnectorDefinition, ConnectorCategory, ToolResultLabel } from "./types";
export { parseToolResult } from "./types";
