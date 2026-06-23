/**
 * Page-side RPC for the Pyodide runtime. Pages (sidepanel, home, …) can't
 * call `chrome.offscreen.createDocument` directly, so we route Python
 * messages through the background service worker, which ensures the
 * offscreen document exists, then forwards to it.
 *
 * Wire format:
 *   page → background    `PYTHON_*` envelope
 *   background → offscreen  `{ target: "offscreen", ... }` re-broadcast
 *   offscreen → background → page  same `chrome.runtime.sendMessage` callback
 */

export interface PythonExecuteRequest {
  conversationId: string;
  /**
   * UUID of the active space, or null when the conversation is not bound to
   * any space. When set, the Python sandbox mounts `/spaces/<spaceId>/workspace`
   * read-only so Python code sees the same shared-space files the agent's fs
   * tools (Read/Glob/Grep/LS) advertise. Required so the contract is explicit:
   * callers must decide whether to expose a shared workspace.
   */
  spaceId: string | null;
  code: string;
  timeoutMs?: number;
  resetState?: boolean;
  allowNetwork?: boolean;
}

export interface PythonExecuteResponse {
  ok: boolean;
  result?: unknown;
  stdout: string;
  stderr: string;
  error?: string;
  errorKind?:
    | "PythonError"
    | "NetworkBlocked"
    | "OutputTooLarge"
    | "Internal"
    | "Timeout";
  timings: { loadMs?: number; runMs: number };
}

function send<T>(message: { type: string } & Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error && !("stdout" in (response ?? {}))) {
        reject(new Error(response.error));
        return;
      }
      resolve(response as T);
    });
  });
}

export function executePythonRPC(
  req: PythonExecuteRequest,
): Promise<PythonExecuteResponse> {
  return send<PythonExecuteResponse>({ type: "PYTHON_EXECUTE", ...req });
}

export function warmupPythonRPC(
  conversationId: string,
): Promise<{ loadMs: number }> {
  return send<{ loadMs: number }>({ type: "PYTHON_WARMUP", conversationId });
}

export function resetPythonRPC(
  conversationId: string,
): Promise<{ ok: boolean }> {
  return send<{ ok: boolean }>({ type: "PYTHON_RESET", conversationId });
}

export function disposePythonRPC(
  conversationId: string,
): Promise<{ ok: boolean }> {
  return send<{ ok: boolean }>({ type: "PYTHON_DISPOSE", conversationId });
}

export interface PythonDebugLogEntry {
  ts: number;
  conversationId: string;
  event: string;
  data?: unknown;
}

export function getPythonDebugLogRPC(): Promise<{ entries: PythonDebugLogEntry[] }> {
  return send<{ entries: PythonDebugLogEntry[] }>({ type: "PYTHON_GET_LOG" });
}

export function clearPythonDebugLogRPC(): Promise<{ ok: boolean }> {
  return send<{ ok: boolean }>({ type: "PYTHON_CLEAR_LOG" });
}
