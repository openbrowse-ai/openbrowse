/**
 * Builds the dynamic "## Workspace files" block injected into the system
 * prompt every turn (alongside the "## Tabs in this conversation" and
 * "## Site skills for open tabs" blocks).
 *
 * Why per-turn injection: artifact tool results (saveAs from executeCode/
 * executeOnPage, files written by executePython, the Write tool) are
 * stored as part of the tool message stream. Long conversations get
 * compacted, and the tool message that contained "I wrote X to /workspace/
 * data.json" can be pruned out — but the FILE remains. Without a per-turn
 * legend the agent loses track of its own outputs and either re-runs the
 * scrape or forgets to integrate the data.
 *
 * Symmetric to `tab-legend.ts`: we re-walk the per-conversation OPFS
 * workspace each turn and render a compact list. Cheap (a few stat reads)
 * for typical workloads (1-20 files); for pathological cases we cap at
 * ENTRY_LIMIT entries with a "... and N more" suffix.
 *
 * Excluded from the listing:
 *   - `.uploads/` — read-only attachment area, not agent-produced.
 *
 * Returns "" when the workspace is empty so the prepareCall append step
 * doesn't emit a stray heading on every fresh conversation.
 */
import { OPFS } from "../vfs/opfs";
import { UPLOADS_DIR } from "../uploads-dir";

const ENTRY_LIMIT = 50;

function workspaceRoot(conversationId: string): string {
  return `conversations/${conversationId}/workspace`;
}

interface FileEntry {
  /** Relative path inside the workspace (no leading slash). */
  relPath: string;
  size: number;
  lastModified: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Render an mtime as a coarse "X ago" relative to now. We deliberately
 * round aggressively — exact timestamps would just be noise to the model
 * and would make the prompt non-deterministic across rapid retries (each
 * turn would produce a different "12 seconds ago" value, breaking
 * prompt caching).
 */
function formatAge(mtimeMs: number, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - mtimeMs);
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * List every file under the conversation's workspace root, with size +
 * mtime metadata. `.uploads/` is excluded. Returns an empty array if the
 * workspace doesn't exist yet (a fresh conversation that hasn't written
 * anything).
 */
async function listWorkspaceFiles(
  conversationId: string,
): Promise<FileEntry[]> {
  const root = workspaceRoot(conversationId);
  const entries: FileEntry[] = [];
  try {
    for await (const fullPath of OPFS.walk(root)) {
      // Strip the conversation-scoped root so the agent sees plain
      // workspace-relative paths matching what `Read` / saveAs return.
      const relPath = fullPath.startsWith(`${root}/`)
        ? fullPath.slice(root.length + 1)
        : fullPath;
      if (relPath === UPLOADS_DIR || relPath.startsWith(`${UPLOADS_DIR}/`)) {
        continue;
      }
      try {
        const file = await OPFS.readFileBytes(fullPath);
        entries.push({
          relPath,
          size: file.size,
          lastModified: file.lastModified,
        });
      } catch {
        // File disappeared between walk() and readFileBytes(); skip silently.
      }
    }
  } catch {
    // Workspace doesn't exist yet — return empty.
  }
  return entries;
}

/**
 * Build the rendered "## Workspace files" block. Empty string when the
 * workspace has no agent-written files (excluding .uploads).
 *
 * `nowMs` is injectable for deterministic tests; defaults to `Date.now()`.
 */
export async function buildWorkspaceFilesBlock(
  conversationId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const entries = await listWorkspaceFiles(conversationId);
  if (entries.length === 0) return "";

  // Most-recently-modified first. Recently-touched files are the ones the
  // agent is most likely to re-engage with on the next turn.
  entries.sort((a, b) => b.lastModified - a.lastModified);

  const truncated = entries.length > ENTRY_LIMIT;
  const visible = truncated ? entries.slice(0, ENTRY_LIMIT) : entries;

  const lines: string[] = [];
  lines.push("## Workspace files");
  lines.push("");
  const totalLabel = entries.length === 1 ? "1 file" : `${entries.length} files`;
  lines.push(`/workspace contents (${totalLabel}):`);
  for (const e of visible) {
    lines.push(
      `- ${e.relPath} (${formatBytes(e.size)}, ${formatAge(e.lastModified, nowMs)})`,
    );
  }
  if (truncated) {
    lines.push(`- ... and ${entries.length - ENTRY_LIMIT} more (use \`LS\` or \`Glob\` to enumerate)`);
  }
  lines.push("");
  lines.push(
    "Use the `Read` tool to load any file; reference paths from `executePython` / `executeOnPage` directly.",
  );
  return lines.join("\n");
}

// Test-only export so the legend renderer can be exercised without OPFS.
export const _internals = { listWorkspaceFiles, formatBytes, formatAge };
