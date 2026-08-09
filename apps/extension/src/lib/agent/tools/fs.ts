import { z } from "zod";
import { parseMemoryPath } from "../../memory/format";
import { memoryStore } from "../../memory/store";
import { isUploadsPath } from "../../uploads-dir";
import { emitVfsChange } from "../../vfs/events";
import { OPFS } from "../../vfs/opfs";
import type { BrowserTool } from "../types";

// Simple glob to regex converter since npm is failing in this env
function globToRegex(glob: string): RegExp {
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regexStr = glob
    .split("**")
    .map((part) => {
      return part
        .split("*")
        .map((subpart) => escapeRegex(subpart))
        .join("[^/]*");
    })
    .join(".*");

  return new RegExp(`^${regexStr}$`);
}

function getVfsRoot(conversationId: string | null): string {
  if (!conversationId) return `cwd`;
  return `conversations/${conversationId}/workspace`;
}

/**
 * True when `rawPath` (with or without leading slash) targets the active
 * space's shared workspace. False when spaceId is null or the path doesn't
 * reference a space.
 */
export function isOwnSpacePath(
  rawPath: string,
  spaceId: string | null,
): boolean {
  if (!spaceId) return false;
  const clean = rawPath.replace(/^\/+/, "");
  const root = `spaces/${spaceId}/workspace`;
  return clean === root || clean.startsWith(`${root}/`);
}

/** True when `rawPath` references ANY space's workspace under `spaces/<id>/workspace/...`. */
export function isAnySpacePath(rawPath: string): boolean {
  const clean = rawPath.replace(/^\/+/, "");
  return /^spaces\/[^/]+\/workspace(\/|$)/.test(clean);
}

/**
 * True when `rawPath` references ANY memory tree — global `memory/...` or any
 * space's `spaces/<id>/memory/...`.
 */
export function isAnyMemoryPath(rawPath: string): boolean {
  const clean = rawPath.replace(/^\/+/, "");
  return (
    clean === "memory" ||
    clean.startsWith("memory/") ||
    /^spaces\/[^/]+\/memory(\/|$)/.test(clean)
  );
}

/**
 * True when `rawPath` is memory the active session may access: the global
 * `memory/...` tree (visible everywhere) or the active space's own memory.
 */
export function isOwnMemoryPath(
  rawPath: string,
  spaceId: string | null,
): boolean {
  const clean = rawPath.replace(/^\/+/, "");
  if (clean === "memory" || clean.startsWith("memory/")) return true;
  if (!spaceId) return false;
  const root = `spaces/${spaceId}/memory`;
  return clean === root || clean.startsWith(`${root}/`);
}

function sanitizePath(p: string): string {
  // Deterministic removal of `..` segments that prevents nested escapes
  // like `....//` which bypass a single `.replace()` regex pass.
  return p
    .split("/")
    .filter((segment) => segment !== "..")
    .join("/");
}

function resolveVfsPath(
  conversationId: string | null,
  spaceId: string | null,
  rawPath: string,
): string {
  const cleanBase = rawPath.replace(/^\/+/, "");
  if (rawPath.startsWith("/skills/")) {
    return sanitizePath(cleanBase);
  }
  if (isOwnMemoryPath(rawPath, spaceId)) {
    return sanitizePath(cleanBase);
  }
  if (isAnyMemoryPath(rawPath)) {
    throw new Error(
      "resolveVfsPath: unreachable cross-space memory path; caller must guard with isAnyMemoryPath",
    );
  }
  if (isOwnSpacePath(rawPath, spaceId)) {
    return sanitizePath(cleanBase);
  }
  if (isAnySpacePath(rawPath)) {
    throw new Error(
      "resolveVfsPath: unreachable cross-space path; caller must guard with isAnySpacePath",
    );
  }
  const root = getVfsRoot(conversationId);
  return `${root}/${sanitizePath(cleanBase)}`;
}

// Strip the VFS root prefix so the LLM only sees relative paths
function stripVfsRoot(conversationId: string | null, fullPath: string): string {
  if (fullPath.startsWith("skills/")) {
    return "/" + fullPath;
  }
  if (fullPath.startsWith("spaces/")) {
    // Space workspace paths are exposed verbatim (no aliasing).
    return fullPath;
  }
  const root = getVfsRoot(conversationId) + "/";
  if (fullPath.startsWith(root)) {
    return fullPath.slice(root.length);
  }
  return fullPath;
}

const SPACE_CROSS_WRITE_DENIED =
  "Error: Permission denied. Path is outside this conversation's space.";
const SPACE_READ_DENIED =
  "Error: Permission denied. Path is outside this conversation's space.";

/**
 * Best-effort: keep the derived memory index in sync after an fs mutation to a
 * memory path. Never throws — the OPFS file is the source of truth, so a failed
 * index update just means the next reconcile fixes it.
 *
 * Re-emits `vfs:change` once the index row is current. The write itself already
 * emitted (from `OPFS.*`), but that fires *before* indexing, so a UI surface
 * rendering parsed frontmatter (`MemoryFileMeta`) would otherwise read the
 * previous row. Subscribers debounce, so the two emits coalesce into one
 * refresh.
 */
async function syncMemoryIndex(resolvedPath: string): Promise<void> {
  try {
    if (!isAnyMemoryPath(resolvedPath)) return;
    await memoryStore.syncPath(resolvedPath);
    emitVfsChange(resolvedPath);
  } catch {
    /* index maintenance is best-effort */
  }
}

/**
 * Soft nudge (spec #5): when the agent creates a NEW memory file, surface any
 * existing memories that look related so it can extend one instead of
 * duplicating. Non-blocking — returned as a suffix on the write result.
 */
async function memoryWriteNudge(
  resolvedPath: string,
  spaceId: string | null,
): Promise<string> {
  try {
    const info = parseMemoryPath(resolvedPath);
    if (!info) return "";
    const { results } = await memoryStore.search(info.slug.replace(/-/g, " "), {
      activeSpaceId: spaceId,
      limit: 4,
    });
    const others = results.filter((r) => r.path !== resolvedPath);
    if (others.length === 0) return "";
    const list = others
      .map((r) => `${r.path}${r.description ? ` (${r.description})` : ""}`)
      .join("; ");
    return `\nRelated existing memories — consider editing one instead of duplicating: ${list}.`;
  } catch {
    return "";
  }
}

export function createFsTools() {
  const readTool: BrowserTool<
    { file_path: string; offset?: number; limit?: number },
    string
  > = {
    name: "Read",
    description:
      "Reads the content of a file. Returns lines prefixed with line numbers.",
    parameters: z.object({
      file_path: z.string(),
      offset: z
        .number()
        .optional()
        .describe("Line number to start reading from (1-indexed)"),
      limit: z.number().optional().describe("Max lines to read (default 2000)"),
    }),
    execute: async ({ file_path, offset, limit }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      const spaceId = ctx.session?.spaceId ?? null;
      if (isAnySpacePath(file_path) && !isOwnSpacePath(file_path, spaceId)) {
        return SPACE_READ_DENIED;
      }
      if (isAnyMemoryPath(file_path) && !isOwnMemoryPath(file_path, spaceId)) {
        return SPACE_READ_DENIED;
      }
      try {
        const fullPath = resolveVfsPath(conversationId, spaceId, file_path);
        const exists = await OPFS.exists(fullPath);
        if (!exists) return `Error: File not found at ${file_path}`;

        const content = await OPFS.readFile(fullPath);
        const lines = content.split("\n");

        const start = Math.max(0, (offset || 1) - 1);
        const maxLines = limit || 2000;
        const end = Math.min(lines.length, start + maxLines);

        const numberedLines = lines
          .slice(start, end)
          .map((line, i) => `${start + i + 1}: ${line}`);

        return numberedLines.join("\n");
      } catch (e) {
        return `Error reading file: ${(e as Error).message}`;
      }
    },
  };

  const writeTool: BrowserTool<{ file_path: string; content: string }, string> =
    {
      name: "Write",
      description:
        "Creates or overwrites a file. Automatically creates parent directories. Writes to the active space's shared workspace require user approval.",
      parameters: z.object({
        file_path: z.string(),
        content: z.string(),
      }),
      approval: { required: true },
      execute: async ({ file_path, content }, ctx) => {
        const conversationId = ctx.session?.conversationId ?? null;
        const spaceId = ctx.session?.spaceId ?? null;
        if (file_path.startsWith("/skills/")) {
          return `Error: Permission denied. Cannot write to global skills directory.`;
        }
        if (isUploadsPath(file_path)) {
          return `Error: Permission denied. Files under /.uploads/ are user-attached and read-only. Write your output to a different path in the workspace.`;
        }
        // Cross-space writes are still denied. Own-space writes are allowed
        // but require user approval (gated in agent-transport's dynamic
        // needsApproval branch for the Write tool).
        if (isAnySpacePath(file_path) && !isOwnSpacePath(file_path, spaceId)) {
          return SPACE_CROSS_WRITE_DENIED;
        }
        if (
          isAnyMemoryPath(file_path) &&
          !isOwnMemoryPath(file_path, spaceId)
        ) {
          return SPACE_CROSS_WRITE_DENIED;
        }
        try {
          const fullPath = resolveVfsPath(conversationId, spaceId, file_path);
          const isMemory = isAnyMemoryPath(fullPath);
          const existedBefore = isMemory ? await OPFS.exists(fullPath) : false;
          await OPFS.writeFile(fullPath, content);
          if (isMemory) {
            await syncMemoryIndex(fullPath);
            if (!existedBefore) {
              const nudge = await memoryWriteNudge(fullPath, spaceId);
              return `File created at ${file_path}.${nudge}`;
            }
          }
          return `File created/updated at ${file_path}.`;
        } catch (e) {
          return `Error writing file: ${(e as Error).message}`;
        }
      },
    };

  const editTool: BrowserTool<
    {
      file_path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    },
    string
  > = {
    name: "Edit",
    description:
      "Performs exact string replacement in a file. Use Read first to verify exact indentation and content. Edits to the active space's shared workspace require user approval.",
    parameters: z.object({
      file_path: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    approval: { required: true },
    execute: async ({ file_path, oldString, newString, replaceAll }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      const spaceId = ctx.session?.spaceId ?? null;
      if (file_path.startsWith("/skills/")) {
        return `Error: Permission denied. Cannot edit files in global skills directory.`;
      }
      if (isUploadsPath(file_path)) {
        return `Error: Permission denied. Files under /.uploads/ are user-attached and read-only.`;
      }
      // Cross-space edits are still denied. Own-space edits are allowed
      // but require user approval (gated in agent-transport).
      if (isAnySpacePath(file_path) && !isOwnSpacePath(file_path, spaceId)) {
        return SPACE_CROSS_WRITE_DENIED;
      }
      if (isAnyMemoryPath(file_path) && !isOwnMemoryPath(file_path, spaceId)) {
        return SPACE_CROSS_WRITE_DENIED;
      }
      try {
        const fullPath = resolveVfsPath(conversationId, spaceId, file_path);
        if (!(await OPFS.exists(fullPath)))
          return `Error: File not found at ${file_path}`;

        const content = await OPFS.readFile(fullPath);

        if (content.indexOf(oldString) === -1) {
          return `Error: oldString not found in file. Ensure exact whitespace matches.`;
        }

        if (
          !replaceAll &&
          content.indexOf(oldString) !== content.lastIndexOf(oldString)
        ) {
          return `Error: Found multiple matches for oldString. Use replaceAll: true or provide more surrounding context.`;
        }

        const updated = replaceAll
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);

        await OPFS.writeFile(fullPath, updated);
        await syncMemoryIndex(fullPath);
        return `File edited successfully at ${file_path}.`;
      } catch (e) {
        return `Error editing file: ${(e as Error).message}`;
      }
    },
  };

  const globTool: BrowserTool<{ pattern: string; path?: string }, string> = {
    name: "Glob",
    description:
      "Finds files matching a glob pattern (e.g. 'src/**/*.ts'). Returns newline-separated paths.",
    parameters: z.object({
      pattern: z.string(),
      path: z
        .string()
        .optional()
        .describe("Directory to search in. Defaults to workspace root."),
    }),
    execute: async ({ pattern, path }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      const spaceId = ctx.session?.spaceId ?? null;
      if (path && isAnySpacePath(path) && !isOwnSpacePath(path, spaceId)) {
        return SPACE_READ_DENIED;
      }
      if (path && isAnyMemoryPath(path) && !isOwnMemoryPath(path, spaceId)) {
        return SPACE_READ_DENIED;
      }
      try {
        const searchRoot = path
          ? resolveVfsPath(conversationId, spaceId, path)
          : getVfsRoot(conversationId);
        const regex = globToRegex(pattern);

        const matches: string[] = [];
        for await (const file of OPFS.walk(searchRoot)) {
          const relativePath = stripVfsRoot(conversationId, file);
          // Match against the path relative to search root to behave like standard glob
          const matchPath = path
            ? relativePath.replace(
                new RegExp(`^${path.replace(/^\/+/, "")}/`),
                "",
              )
            : relativePath;
          if (regex.test(matchPath)) {
            matches.push(relativePath);
          }
        }

        if (matches.length === 0) return `No files found matching ${pattern}`;
        return matches.join("\n");
      } catch (e) {
        return `Error searching files: ${(e as Error).message}`;
      }
    },
  };

  const grepTool: BrowserTool<
    { pattern: string; path?: string; include?: string },
    string
  > = {
    name: "Grep",
    description:
      "Searches file contents using regular expressions. Returns 'path:line:content'.",
    parameters: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      include: z
        .string()
        .optional()
        .describe("File pattern to include (e.g. '*.js')"),
    }),
    execute: async ({ pattern, path, include }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      const spaceId = ctx.session?.spaceId ?? null;
      if (path && isAnySpacePath(path) && !isOwnSpacePath(path, spaceId)) {
        return SPACE_READ_DENIED;
      }
      if (path && isAnyMemoryPath(path) && !isOwnMemoryPath(path, spaceId)) {
        return SPACE_READ_DENIED;
      }
      try {
        const searchRoot = path
          ? resolveVfsPath(conversationId, spaceId, path)
          : getVfsRoot(conversationId);
        const searchRegex = new RegExp(pattern);
        const includeRegex = include ? globToRegex(include) : null;

        const results: string[] = [];

        for await (const file of OPFS.walk(searchRoot)) {
          const relativePath = stripVfsRoot(conversationId, file);

          if (includeRegex) {
            const fileName = relativePath.split("/").pop() || "";
            if (
              !includeRegex.test(fileName) &&
              !includeRegex.test(relativePath)
            )
              continue;
          }

          try {
            const content = await OPFS.readFile(file);
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (searchRegex.test(lines[i])) {
                results.push(`${relativePath}:${i + 1}:${lines[i]}`);
              }
            }
          } catch (e) {
            // Skip unreadable files (e.g. binaries)
          }
        }

        if (results.length === 0)
          return `No matches found for pattern /${pattern}/`;
        return results.join("\n");
      } catch (e) {
        return `Error performing grep: ${(e as Error).message}`;
      }
    },
  };

  const lsTool: BrowserTool<{ path: string }, string> = {
    name: "LS",
    description:
      "Lists files and directories in a specific folder. Directories have a trailing slash.",
    parameters: z.object({
      path: z.string().describe("Path to list (use '.' or '' for root)"),
    }),
    execute: async ({ path }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      const spaceId = ctx.session?.spaceId ?? null;
      if (path && isAnySpacePath(path) && !isOwnSpacePath(path, spaceId)) {
        return SPACE_READ_DENIED;
      }
      if (path && isAnyMemoryPath(path) && !isOwnMemoryPath(path, spaceId)) {
        return SPACE_READ_DENIED;
      }
      try {
        const targetPath = path === "." || !path ? "" : path;
        const fullPath = resolveVfsPath(conversationId, spaceId, targetPath);

        const exists = await OPFS.exists(fullPath);
        if (!exists) return `Error: Directory not found at ${path}`;

        const entries = await OPFS.readDir(fullPath);
        if (entries.length === 0) return `(empty directory)`;
        return entries.sort().join("\n");
      } catch (e) {
        return `Error listing directory: ${(e as Error).message}`;
      }
    },
  };

  const deleteTool: BrowserTool<{ path: string }, string> = {
    name: "Delete",
    description:
      "Deletes a file or directory (recursively) from your workspace. Use to prune obsolete files. Requires user approval. The read-only `/skills/` directory and user-attached `/.uploads/` files cannot be deleted. (To remove a site skill, use delete_site_skill instead.)",
    parameters: z.object({
      path: z.string().describe("Path to delete (file or directory)."),
    }),
    approval: { required: true },
    execute: async ({ path }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      const spaceId = ctx.session?.spaceId ?? null;
      if (path.startsWith("/skills/")) {
        return `Error: Permission denied. Cannot delete files in the global skills directory.`;
      }
      if (isUploadsPath(path)) {
        return `Error: Permission denied. Files under /.uploads/ are user-attached and cannot be deleted.`;
      }
      // The shared space workspace is read-only to the agent; explicit
      // deletes targeting `spaces/<id>/workspace/...` are rejected the
      // same way Write/Edit are guarded elsewhere in this file.
      if (isAnySpacePath(path)) {
        return SPACE_CROSS_WRITE_DENIED;
      }
      if (isAnyMemoryPath(path) && !isOwnMemoryPath(path, spaceId)) {
        return SPACE_CROSS_WRITE_DENIED;
      }
      try {
        const fullPath = resolveVfsPath(conversationId, spaceId, path);
        // Recursive so a whole folder can go in one call. OPFS.rm treats a
        // missing path as a no-op success.
        await OPFS.rm(fullPath, { recursive: true });
        await syncMemoryIndex(fullPath);
        return `Deleted ${path}.`;
      } catch (e) {
        return `Error deleting: ${(e as Error).message}`;
      }
    },
  };

  const moveTool: BrowserTool<{ from_path: string; to_path: string }, string> =
    {
      name: "Move",
      description:
        "Moves or renames a file within your workspace or memory. Use to reorganize memory into folders. Fails if the destination already exists.",
      parameters: z.object({
        from_path: z.string(),
        to_path: z.string(),
      }),
      execute: async ({ from_path, to_path }, ctx) => {
        const conversationId = ctx.session?.conversationId ?? null;
        const spaceId = ctx.session?.spaceId ?? null;
        for (const p of [from_path, to_path]) {
          if (p.startsWith("/skills/")) {
            return `Error: Permission denied. Cannot move files in the global skills directory.`;
          }
          if (isUploadsPath(p)) {
            return `Error: Permission denied. Files under /.uploads/ cannot be moved.`;
          }
          if (isAnySpacePath(p) && !isOwnSpacePath(p, spaceId)) {
            return SPACE_CROSS_WRITE_DENIED;
          }
          if (isAnyMemoryPath(p) && !isOwnMemoryPath(p, spaceId)) {
            return SPACE_CROSS_WRITE_DENIED;
          }
        }
        try {
          const fromFull = resolveVfsPath(conversationId, spaceId, from_path);
          const toFull = resolveVfsPath(conversationId, spaceId, to_path);
          if (!(await OPFS.exists(fromFull))) {
            return `Error: Source not found at ${from_path}`;
          }
          if (await OPFS.exists(toFull)) {
            return `Error: Destination already exists at ${to_path}`;
          }
          const bytes = await OPFS.readFileBytes(fromFull);
          await OPFS.writeFileBytes(toFull, await bytes.arrayBuffer());
          await OPFS.rm(fromFull, { recursive: true });
          await syncMemoryIndex(fromFull);
          await syncMemoryIndex(toFull);
          return `Moved ${from_path} \u2192 ${to_path}.`;
        } catch (e) {
          return `Error moving: ${(e as Error).message}`;
        }
      },
    };

  return {
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    lsTool,
    deleteTool,
    moveTool,
  };
}
