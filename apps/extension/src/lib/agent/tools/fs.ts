import { z } from "zod";
import type { BrowserTool } from "../types";
import { OPFS } from "../../vfs/opfs";
import { isUploadsPath } from "../../uploads-dir";

// Simple glob to regex converter since npm is failing in this env
function globToRegex(glob: string): RegExp {
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  const regexStr = glob
    .split('**')
    .map(part => {
      return part
        .split('*')
        .map(subpart => escapeRegex(subpart))
        .join('[^/]*');
    })
    .join('.*');
    
  return new RegExp(`^${regexStr}$`);
}

function getVfsRoot(conversationId: string | null): string {
  if (!conversationId) return `cwd`;
  return `conversations/${conversationId}/workspace`;
}

function resolveVfsPath(conversationId: string | null, rawPath: string): string {
  // Allow explicit escaping to skills directory (read-only in tools)
  if (rawPath.startsWith('/skills/')) {
    return rawPath.replace(/^\/+/, '');
  }
  const root = getVfsRoot(conversationId);
  const clean = rawPath.replace(/^\/+/, '').replace(/\.\.\//g, '');
  return `${root}/${clean}`;
}

// Strip the VFS root prefix so the LLM only sees relative paths
function stripVfsRoot(conversationId: string | null, fullPath: string): string {
  if (fullPath.startsWith('skills/')) {
    return '/' + fullPath;
  }
  const root = getVfsRoot(conversationId) + '/';
  if (fullPath.startsWith(root)) {
    return fullPath.slice(root.length);
  }
  return fullPath;
}

export function createFsTools() {
  const readTool: BrowserTool<{ file_path: string; offset?: number; limit?: number }, string> = {
    name: "Read",
    description: "Reads the content of a file. Returns lines prefixed with line numbers.",
    parameters: z.object({
      file_path: z.string(),
      offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
      limit: z.number().optional().describe("Max lines to read (default 2000)"),
    }),
    execute: async ({ file_path, offset, limit }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      try {
        const fullPath = resolveVfsPath(conversationId, file_path);
        const exists = await OPFS.exists(fullPath);
        if (!exists) return `Error: File not found at ${file_path}`;

        const content = await OPFS.readFile(fullPath);
        const lines = content.split('\n');
        
        const start = Math.max(0, (offset || 1) - 1);
        const maxLines = limit || 2000;
        const end = Math.min(lines.length, start + maxLines);
        
        const numberedLines = lines
          .slice(start, end)
          .map((line, i) => `${start + i + 1}: ${line}`);
          
        return numberedLines.join('\n');
      } catch (e) {
        return `Error reading file: ${(e as Error).message}`;
      }
    }
  };

  const writeTool: BrowserTool<{ file_path: string; content: string }, string> = {
    name: "Write",
    description: "Creates or overwrites a file. Automatically creates parent directories.",
    parameters: z.object({
      file_path: z.string(),
      content: z.string(),
    }),
    execute: async ({ file_path, content }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      if (file_path.startsWith('/skills/')) {
        return `Error: Permission denied. Cannot write to global skills directory.`;
      }
      if (isUploadsPath(file_path)) {
        return `Error: Permission denied. Files under /.uploads/ are user-attached and read-only. Write your output to a different path in the workspace.`;
      }
      try {
        const fullPath = resolveVfsPath(conversationId, file_path);
        await OPFS.writeFile(fullPath, content);
        return `File created/updated at ${file_path}.`;
      } catch (e) {
        return `Error writing file: ${(e as Error).message}`;
      }
    }
  };

  const editTool: BrowserTool<{ file_path: string; oldString: string; newString: string; replaceAll?: boolean }, string> = {
    name: "Edit",
    description: "Performs exact string replacement in a file. Use Read first to verify exact indentation and content.",
    parameters: z.object({
      file_path: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    execute: async ({ file_path, oldString, newString, replaceAll }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      if (file_path.startsWith('/skills/')) {
        return `Error: Permission denied. Cannot edit files in global skills directory.`;
      }
      if (isUploadsPath(file_path)) {
        return `Error: Permission denied. Files under /.uploads/ are user-attached and read-only.`;
      }
      try {
        const fullPath = resolveVfsPath(conversationId, file_path);
        if (!(await OPFS.exists(fullPath))) return `Error: File not found at ${file_path}`;

        const content = await OPFS.readFile(fullPath);
        
        if (content.indexOf(oldString) === -1) {
          return `Error: oldString not found in file. Ensure exact whitespace matches.`;
        }
        
        if (!replaceAll && content.indexOf(oldString) !== content.lastIndexOf(oldString)) {
          return `Error: Found multiple matches for oldString. Use replaceAll: true or provide more surrounding context.`;
        }

        const updated = replaceAll 
          ? content.split(oldString).join(newString)
          : content.replace(oldString, newString);
          
        await OPFS.writeFile(fullPath, updated);
        return `File edited successfully at ${file_path}.`;
      } catch (e) {
        return `Error editing file: ${(e as Error).message}`;
      }
    }
  };

  const globTool: BrowserTool<{ pattern: string; path?: string }, string> = {
    name: "Glob",
    description: "Finds files matching a glob pattern (e.g. 'src/**/*.ts'). Returns newline-separated paths.",
    parameters: z.object({
      pattern: z.string(),
      path: z.string().optional().describe("Directory to search in. Defaults to workspace root."),
    }),
    execute: async ({ pattern, path }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      try {
        const searchRoot = path ? resolveVfsPath(conversationId, path) : getVfsRoot(conversationId);
        const regex = globToRegex(pattern);
        
        const matches: string[] = [];
        for await (const file of OPFS.walk(searchRoot)) {
          const relativePath = stripVfsRoot(conversationId, file);
          // Match against the path relative to search root to behave like standard glob
          const matchPath = path ? relativePath.replace(new RegExp(`^${path.replace(/^\/+/, '')}/`), '') : relativePath;
          if (regex.test(matchPath)) {
            matches.push(relativePath);
          }
        }
        
        if (matches.length === 0) return `No files found matching ${pattern}`;
        return matches.join('\n');
      } catch (e) {
        return `Error searching files: ${(e as Error).message}`;
      }
    }
  };

  const grepTool: BrowserTool<{ pattern: string; path?: string; include?: string }, string> = {
    name: "Grep",
    description: "Searches file contents using regular expressions. Returns 'path:line:content'.",
    parameters: z.object({
      pattern: z.string(),
      path: z.string().optional(),
      include: z.string().optional().describe("File pattern to include (e.g. '*.js')"),
    }),
    execute: async ({ pattern, path, include }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      try {
        const searchRoot = path ? resolveVfsPath(conversationId, path) : getVfsRoot(conversationId);
        const searchRegex = new RegExp(pattern);
        const includeRegex = include ? globToRegex(include) : null;
        
        const results: string[] = [];
        
        for await (const file of OPFS.walk(searchRoot)) {
          const relativePath = stripVfsRoot(conversationId, file);
          
          if (includeRegex) {
            const fileName = relativePath.split('/').pop() || '';
            if (!includeRegex.test(fileName) && !includeRegex.test(relativePath)) continue;
          }
          
          try {
            const content = await OPFS.readFile(file);
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (searchRegex.test(lines[i])) {
                results.push(`${relativePath}:${i + 1}:${lines[i]}`);
              }
            }
          } catch (e) {
            // Skip unreadable files (e.g. binaries)
          }
        }
        
        if (results.length === 0) return `No matches found for pattern /${pattern}/`;
        return results.join('\n');
      } catch (e) {
        return `Error performing grep: ${(e as Error).message}`;
      }
    }
  };

  const lsTool: BrowserTool<{ path: string }, string> = {
    name: "LS",
    description: "Lists files and directories in a specific folder. Directories have a trailing slash.",
    parameters: z.object({
      path: z.string().describe("Path to list (use '.' or '' for root)"),
    }),
    execute: async ({ path }, ctx) => {
      const conversationId = ctx.session?.conversationId ?? null;
      try {
        const targetPath = (path === '.' || !path) ? '' : path;
        const fullPath = resolveVfsPath(conversationId, targetPath);
        
        const exists = await OPFS.exists(fullPath);
        if (!exists) return `Error: Directory not found at ${path}`;
        
        const entries = await OPFS.readDir(fullPath);
        if (entries.length === 0) return `(empty directory)`;
        return entries.sort().join('\n');
      } catch (e) {
        return `Error listing directory: ${(e as Error).message}`;
      }
    }
  };

  return { readTool, writeTool, editTool, globTool, grepTool, lsTool };
}
