import type { SerializedUIPart, SerializedToolPart } from "@/lib/agent/message-types";
import { resolveMcpToolDisplay } from "@/components/chat/mcp-tool-display";

export interface DerivedConnector {
  id: string;
  name: string;
}

/** Type guard: narrow a part to the persisted tool-call variant. */
function isToolPart(part: SerializedUIPart): part is SerializedToolPart {
  return part.type === "dynamic-tool";
}

/**
 * Derive the distinct connectors a conversation actually used, by scanning
 * its persisted message parts for `mcp_*` tool calls and mapping each to a
 * known connector. Unmatched MCP servers (no connector) are skipped (v1).
 * Deduped by connector id, preserving first-seen order.
 */
export function deriveUsedConnectors(
  parts: SerializedUIPart[],
): DerivedConnector[] {
  const seen = new Set<string>();
  const out: DerivedConnector[] = [];
  for (const part of parts) {
    if (!isToolPart(part)) continue;
    if (!part.toolName.startsWith("mcp_")) continue;
    const { mcpInfo } = resolveMcpToolDisplay(part.toolName);
    if (!mcpInfo) continue;
    const { id, name } = mcpInfo.connector;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/**
 * Derive the distinct skill names a conversation loaded, by scanning its
 * persisted message parts for `skill` tool calls (input `{ name }`).
 * Deduped, preserving first-seen order.
 */
export function deriveLoadedSkills(parts: SerializedUIPart[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!isToolPart(part)) continue;
    if (part.toolName !== "skill") continue;
    const input = part.input as { name?: unknown } | undefined;
    const name = input?.name;
    if (typeof name !== "string" || name.length === 0) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}
