import { OPFS } from "@/lib/vfs/opfs";
import { isUploadsPath } from "@/lib/uploads-dir";

/**
 * Manages Pyodide execution using a hidden sandbox iframe instead of a Worker.
 * 
 * Why a Sandbox iframe?
 * - Pyodide requires \`unsafe-eval\` for its EM_ASM / ASM_CONSTS Emscripten glue.
 * - MV3 forbids \`unsafe-eval\` in \`extension_pages\` CSP.
 * - \`sandbox\` pages have an opaque origin and allow \`unsafe-eval\`.
 * 
 * However, sandbox pages cannot access the extension's OPFS. Therefore, we:
 * 1. Read all files from OPFS (`/conversations/<id>/workspace`, `/skills`,
 *    and `/spaces/<spaceId>/workspace` when a space is active).
 * 2. Send them via postMessage to the iframe.
 * 3. Iframe mounts each tree at its real absolute path in MEMFS (no
 *    aliasing — paths match what the agent's fs tools advertise), runs
 *    code, extracts modified files from the conversation workspace ONLY.
 * 4. Iframe sends them back via postMessage.
 * 5. We write them back to OPFS. /skills and /spaces/<id>/workspace are
 *    read-only mounts and are NOT round-tripped.
 */

const IDLE_EVICTION_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunPythonOptions {
  conversationId: string;
  /**
   * UUID of the active space, or null when the conversation is not bound to
   * any space. When set, the iframe mounts `/spaces/<spaceId>/workspace`
   * read-only so Python sees the same shared-space tree as the agent's fs
   * tools.
   */
  spaceId: string | null;
  code: string;
  timeoutMs?: number;
  resetState?: boolean;
  allowNetwork?: boolean;
}

export interface RunPythonResult {
  ok: boolean;
  result?: unknown;
  stdout: string;
  stderr: string;
  error?: string;
  errorKind?: "PythonError" | "NetworkBlocked" | "OutputTooLarge" | "Internal" | "Timeout";
  timings: { loadMs?: number; runMs: number };
}

interface SandboxEntry {
  iframe: HTMLIFrameElement;
  lastUsed: number;
  queue: Promise<unknown>;
  nextId: number;
}

export class PyodideSandboxManager {
  private sandboxes = new Map<string, SandboxEntry>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.sweeper = setInterval(() => this.idleSweep(), 60_000);
  }

  private getOrCreate(conversationId: string): SandboxEntry {
    const existing = this.sandboxes.get(conversationId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    const iframe = document.createElement("iframe");
    iframe.src = chrome.runtime.getURL("python-sandbox.html");
    iframe.style.display = "none";
    
    // Attach load listener BEFORE appending to DOM to avoid missing the event
    iframe.addEventListener("load", () => {
      iframe.setAttribute("data-ready", "1");
    }, { once: true });
    
    document.body.appendChild(iframe);

    const entry: SandboxEntry = {
      iframe,
      lastUsed: Date.now(),
      queue: Promise.resolve(),
      nextId: 1,
    };
    this.sandboxes.set(conversationId, entry);
    return entry;
  }

  dispose(conversationId: string) {
    const entry = this.sandboxes.get(conversationId);
    if (!entry) return;
    try { entry.iframe.remove(); } catch { /* noop */ }
    this.sandboxes.delete(conversationId);
  }

  async warmup(conversationId: string): Promise<{ loadMs: number }> {
    // Just create the iframe. Actual pyodide init happens on first RUN
    this.getOrCreate(conversationId);
    return { loadMs: 0 };
  }

  async reset(conversationId: string): Promise<void> {
    const entry = this.sandboxes.get(conversationId);
    if (!entry) return;
    // We send a blank RUN with resetState just to clear globals and MEMFS
    const id = entry.nextId++;
    entry.queue = entry.queue
      .catch(() => undefined)
      .then(() => new Promise<void>((resolve) => {
        const onMessage = (e: MessageEvent) => {
          if (e.data?.id === id) {
            window.removeEventListener("message", onMessage);
            resolve();
          }
        };
        window.addEventListener("message", onMessage);
        entry.iframe.contentWindow?.postMessage({
          type: "RUN",
          id,
          code: "pass",
          resetState: true,
          // No mount roots: a reset RUN just clears state. The iframe
          // tolerates null mount roots and skips mounting/chdir.
          conversationWorkspaceRoot: null,
          skillsRoot: "/skills",
          spaceWorkspaceRoot: null,
          workspaceFiles: {},
          skillsFiles: {},
          spaceFiles: {},
        }, "*");
      }));
    await entry.queue;
  }

  // Load all files from OPFS tree into a flat map of bytes. Binary-safe:
  // PDFs, images, etc. round-trip without UTF-8 corruption.
  private async loadOpfsTree(rootPath: string): Promise<Record<string, Uint8Array>> {
    const result: Record<string, Uint8Array> = {};
    if (!(await OPFS.exists(rootPath))) return result;

    // Walk OPFS relative to rootPath
    for await (const file of OPFS.walk(rootPath)) {
      // file path returned from walk includes rootPath
      const relPath = file.substring(rootPath.length).replace(/^\/+/, "");
      const blob = await OPFS.readFileBytes(file);
      result[relPath] = new Uint8Array(await blob.arrayBuffer());
    }
    return result;
  }

  // Write flat map of bytes back to OPFS tree. Files under the
  // user-uploads subdir are SKIPPED — they're treated as read-only
  // inputs the agent cannot modify (mirrors the same guard in the
  // `Write`/`Edit` agent tools). If the Python sandbox modified them
  // in MEMFS, the change stays inside the sandbox and is discarded on
  // the next run.
  private async writeOpfsTree(rootPath: string, files: Record<string, Uint8Array>): Promise<void> {
    for (const [relPath, content] of Object.entries(files)) {
      if (isUploadsPath(relPath)) continue;
      const fullPath = `${rootPath}/${relPath}`;
      await OPFS.writeFileBytes(fullPath, content);
    }
  }

  async runPython(opts: RunPythonOptions): Promise<RunPythonResult> {
    const entry = this.getOrCreate(opts.conversationId);
    const timeoutMs = Math.min(
      Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const id = entry.nextId++;
    entry.lastUsed = Date.now();

    const run = entry.queue
      .catch(() => undefined)
      .then(() => this.dispatchRun(entry, id, opts, timeoutMs));
    entry.queue = run.catch(() => undefined);
    return run;
  }

  private async dispatchRun(
    entry: SandboxEntry,
    id: number,
    opts: RunPythonOptions,
    timeoutMs: number,
  ): Promise<RunPythonResult> {
    // 1. Read files. Paths are kept verbatim — no MEMFS aliasing. The
    // sandbox mounts each tree at its absolute OPFS path so paths in
    // Python match what the agent's fs tools (Read/Glob/Grep/LS) see.
    const workspaceRoot = `conversations/${opts.conversationId}/workspace`;
    const workspaceFiles = await this.loadOpfsTree(workspaceRoot);
    const skillsFiles = await this.loadOpfsTree("skills");
    const spaceWorkspaceRoot = opts.spaceId
      ? `spaces/${opts.spaceId}/workspace`
      : null;
    const spaceFiles = spaceWorkspaceRoot
      ? await this.loadOpfsTree(spaceWorkspaceRoot)
      : {};

    return new Promise<RunPythonResult>((resolve) => {
      let settled = false;
      const onMessage = async (e: MessageEvent) => {
        if (e.data?.id !== id || e.data?.type !== "RESULT") return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        entry.lastUsed = Date.now();
        const data = e.data;

        // Write files back
        if (data.workspaceFiles) {
          try {
            await this.writeOpfsTree(workspaceRoot, data.workspaceFiles);
          } catch (err) {
            console.error("[python] Failed to write back workspace files", err);
          }
        }

        resolve({
          ok: !data.error,
          result: data.result,
          stdout: data.stdout ?? "",
          stderr: data.stderr ?? "",
          error: data.error,
          errorKind: data.errorKind,
          timings: data.timings ?? { runMs: 0 },
        });
      };
      
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        this.dispose(opts.conversationId);
        resolve({
          ok: false,
          stdout: "",
          stderr: "",
          error: `Execution timed out after ${timeoutMs}ms`,
          errorKind: "Timeout",
          timings: { runMs: timeoutMs },
        });
      }, timeoutMs);

      window.addEventListener("message", onMessage);
      
      // Ensure iframe is loaded
      const send = () => {
        entry.iframe.contentWindow?.postMessage({
          type: "RUN",
          id,
          code: opts.code,
          allowNetwork: opts.allowNetwork,
          resetState: opts.resetState,
          // Files keyed by the real OPFS path (verbatim — no aliasing).
          // The sandbox mounts each tree at its absolute path under MEMFS
          // and chdirs into the conversation workspace.
          conversationWorkspaceRoot: `/${workspaceRoot}`,
          skillsRoot: "/skills",
          spaceWorkspaceRoot: spaceWorkspaceRoot ? `/${spaceWorkspaceRoot}` : null,
          workspaceFiles,
          skillsFiles,
          spaceFiles,
        }, "*");
      };

      if (entry.iframe.contentWindow && entry.iframe.getAttribute("data-ready")) {
        send();
      } else {
        entry.iframe.addEventListener("load", () => {
          send();
        }, { once: true });
      }
    });
  }

  private idleSweep() {
    const cutoff = Date.now() - IDLE_EVICTION_MS;
    for (const [id, entry] of this.sandboxes) {
      if (entry.lastUsed < cutoff) {
        this.dispose(id);
      }
    }
  }
}

let singleton: PyodideSandboxManager | null = null;
export function getPyodideManager(): PyodideSandboxManager {
  if (!singleton) singleton = new PyodideSandboxManager();
  return singleton;
}

export async function getPersistedPythonLog() { return []; }
export async function clearPersistedPythonLog() {}
