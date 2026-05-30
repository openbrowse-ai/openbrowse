import { getMcpRegistry } from "@/lib/mcp";
import {
  getConnectorForMcpTool,
  type ConnectorDefinition,
} from "@openbrowse/connectors";

/**
 * Parse the human-readable tool name out of an MCP tool key of the form
 * `mcp_<serverId>_<toolName>`, normalizing separators to spaces.
 *
 * Returns the lowercase, space-separated name (e.g. "create record")
 * or `null` when `toolKey` is not an MCP tool.
 */
export function parseMcpToolName(toolKey: string): string | null {
  const match = toolKey.match(/^mcp_[^_]+_(.+)$/);
  if (!match) return null;
  return match[1].replace(/_/g, " ").replace(/-/g, " ");
}

/** Sentence-case: capitalize the first character only. */
function toSentenceCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface McpToolDisplay {
  /**
   * Connector match for the MCP server, when the tool maps to a known
   * connector (used to render the connector logo). `null` for unmatched
   * MCP servers (generic/UUID server ids) and for non-MCP built-in tools.
   */
  mcpInfo: { connector: ConnectorDefinition; toolName: string } | null;
  /**
   * Lowercase, space-separated readable name (e.g. "create record").
   * Suitable for embedding mid-sentence ("Running {name}…"). `null` for
   * non-MCP tools.
   */
  readableName: string | null;
  /**
   * Sentence-cased standalone readable name (e.g. "Create record").
   * Suitable for standalone labels (approval header, done row). `null`
   * for non-MCP tools.
   */
  readableNameSentence: string | null;
}

/**
 * Resolve the display metadata for a tool name, with first-class support
 * for MCP tools (`mcp_<serverId>_<toolName>`).
 *
 * Shared by `ToolCallBlock` (the non-approval renderer) and
 * `ToolApprovalBlock` so both surface the same connector logo and
 * human-readable name. Previously this logic was inline in
 * `ToolCallBlock` only, so approval prompts showed the raw
 * `mcp_<uuid>_<tool>` identifier with no icon.
 *
 * For non-MCP tools, all readable-name fields are `null` and callers
 * fall back to the raw `toolName`.
 */
export function resolveMcpToolDisplay(toolName: string): McpToolDisplay {
  const serverIdMatch = toolName.match(/^mcp_([^_]+)_/);
  const serverUrl = serverIdMatch
    ? getMcpRegistry()
        .getStates()
        .find((s) => s.config.id === serverIdMatch[1])?.config.url
    : undefined;
  const mcpInfo = getConnectorForMcpTool(toolName, serverUrl);

  // Prefer the connector's clean tool name when matched; otherwise parse
  // the raw MCP key. Either way normalize separators to spaces.
  const rawName = mcpInfo
    ? mcpInfo.toolName.replace(/_/g, " ").replace(/-/g, " ")
    : parseMcpToolName(toolName);

  return {
    mcpInfo,
    readableName: rawName,
    readableNameSentence: rawName ? toSentenceCase(rawName) : null,
  };
}
