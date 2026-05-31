import { resolveMcpToolDisplay } from "@/components/chat/mcp-tool-display";

/** Minimal shape of an AI SDK tool call we read. */
export interface ToolCallLike {
  toolName: string;
  input?: unknown;
}

export interface ScannedToolUsage {
  connectorIds: string[];
  skillNames: string[];
}

/**
 * Scan a finished step's tool calls for connector and skill usage.
 *
 * - `mcp_*` tool names map to a connector id via `resolveMcpToolDisplay`;
 *   unmatched MCP servers (no known connector) are skipped.
 * - `skill` tool calls contribute their non-empty string `input.name`.
 *
 * Any invocation counts (we do not inspect tool-call success/state),
 * matching the prior message-derived semantics. Results are NOT deduped
 * here — `mergeDistinct` handles dedup against existing stored values.
 */
export function scanToolUsage(
  toolCalls: readonly ToolCallLike[],
): ScannedToolUsage {
  const connectorIds: string[] = [];
  const skillNames: string[] = [];
  for (const call of toolCalls) {
    if (call.toolName.startsWith("mcp_")) {
      const id = resolveMcpToolDisplay(call.toolName).mcpInfo?.connector.id;
      if (id) connectorIds.push(id);
    } else if (call.toolName === "skill") {
      const name = (call.input as { name?: unknown } | undefined)?.name;
      if (typeof name === "string" && name.length > 0) skillNames.push(name);
    }
  }
  return { connectorIds, skillNames };
}

/**
 * Merge `incoming` ids into `existing`, preserving first-seen order and
 * deduping. Returns the new array only when it differs from `existing`
 * (i.e. at least one genuinely-new entry); returns `null` otherwise so
 * callers can skip a no-op write.
 */
export function mergeDistinct(
  existing: string[] | undefined,
  incoming: string[],
): string[] | null {
  const base = existing ?? [];
  const seen = new Set(base);
  let changed = false;
  const out = [...base];
  for (const item of incoming) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
      changed = true;
    }
  }
  return changed ? out : null;
}
