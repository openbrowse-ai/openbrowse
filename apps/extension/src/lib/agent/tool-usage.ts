import { resolveMcpToolDisplay } from "@/components/chat/mcp-tool-display";

/** Minimal shape of an AI SDK tool call we read. */
export interface ToolCallLike {
  toolName: string;
  input?: unknown;
}

export interface ScannedToolUsage {
  connectorIds: string[];
  skillNames: string[];
  /**
   * Workspace-relative paths under the active space's workspace touched
   * by Read/Write/Edit calls in this batch. Empty when `spaceId` is null
   * or no fs call targeted the active space. NOT deduped — `mergeDistinct`
   * handles dedup against the persisted list.
   */
  spaceFiles: string[];
}

/** Tool names whose `input.file_path` is interpreted as a VFS path. */
const FS_FILE_PATH_TOOLS = new Set(["Read", "Write", "Edit"]);

/**
 * Extract the workspace-relative tail from a path that targets
 * `spaces/<spaceId>/workspace/<rel>`. Returns null when the path doesn't
 * match (different space, conversation workspace, bare root, etc.).
 *
 * - Strips a leading slash so both `/spaces/...` and `spaces/...` match.
 * - The bare workspace root (with or without trailing slash) is rejected:
 *   it's a directory, not a file.
 */
function extractActiveSpaceRelative(
  rawPath: unknown,
  spaceId: string,
): string | null {
  if (typeof rawPath !== "string") return null;
  const clean = rawPath.replace(/^\/+/, "");
  const root = `spaces/${spaceId}/workspace`;
  if (clean === root || clean === `${root}/`) return null;
  if (!clean.startsWith(`${root}/`)) return null;
  return clean.slice(root.length + 1);
}

/**
 * Scan a finished step's tool calls for connector / skill / space-file usage.
 *
 * - `mcp_*` tool names map to a connector id via `resolveMcpToolDisplay`;
 *   unmatched MCP servers (no known connector) are skipped.
 * - `skill` tool calls contribute their non-empty string `input.name`.
 * - `Read` / `Write` / `Edit` calls whose `input.file_path` targets the
 *   ACTIVE space (`spaces/<spaceId>/workspace/...`) contribute the
 *   workspace-relative tail (e.g. `poem.md`, `sub/data.csv`). When
 *   `spaceId` is null the agent cannot reference any space's workspace,
 *   so the array is empty.
 *
 * Any invocation counts (we do not inspect tool-call success/state),
 * matching the prior message-derived semantics. Results are NOT deduped
 * here — `mergeDistinct` handles dedup against existing stored values.
 */
export function scanToolUsage(
  toolCalls: readonly ToolCallLike[],
  spaceId: string | null,
): ScannedToolUsage {
  const connectorIds: string[] = [];
  const skillNames: string[] = [];
  const spaceFiles: string[] = [];
  for (const call of toolCalls) {
    if (call.toolName.startsWith("mcp_")) {
      const id = resolveMcpToolDisplay(call.toolName).mcpInfo?.connector.id;
      if (id) connectorIds.push(id);
    } else if (call.toolName === "skill") {
      const name = (call.input as { name?: unknown } | undefined)?.name;
      if (typeof name === "string" && name.length > 0) skillNames.push(name);
    } else if (spaceId && FS_FILE_PATH_TOOLS.has(call.toolName)) {
      const filePath = (call.input as { file_path?: unknown } | undefined)
        ?.file_path;
      const rel = extractActiveSpaceRelative(filePath, spaceId);
      if (rel) spaceFiles.push(rel);
    }
  }
  return { connectorIds, skillNames, spaceFiles };
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
