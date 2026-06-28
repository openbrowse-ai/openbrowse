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
 *
 * Realm-aware dispatch: under the SW-host migration, the agent loop
 * runs inside the service worker and calls these helpers directly.
 * `chrome.runtime.sendMessage` does NOT deliver back to the sender's
 * own listeners — the SW would have to reach itself, but Chrome routes
 * the message past the SW's onMessage listener to other realms only.
 * `swRpc` short-circuits in the SW realm by invoking the SW-side
 * handler in-process; in renderer realms it falls back to
 * `chrome.runtime.sendMessage` unchanged. Without this, every
 * SW-hosted `executePython` call landed only in the offscreen
 * document (whose listener guards on `target === "offscreen"` and
 * ignored the raw `PYTHON_*` envelope), the port closed with no
 * response, and the tool surfaced "Error (Internal): The message
 * port closed before a response was received." in the chat UI.
 */

import { swRpc } from "@/lib/runtime/sw-rpc";

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
  return new Promise<T>((resolve, reject) => {
    swRpc<typeof message, unknown>(message, async () => {
      const mod = await import("@/entrypoints/background/python-messages");
      return mod.handlePythonMessage as never;
    })
      .then((response) => {
        // Mirror the legacy chrome.runtime.sendMessage error semantics:
        // an envelope that ONLY contains an `error` field is a transport
        // failure and rejects; an envelope that ALSO contains `stdout`
        // is a successful PythonExecuteResponse with `errorKind` set
        // (the latter must resolve so the tool surface can render the
        // structured error and timings).
        if (
          response &&
          typeof response === "object" &&
          "error" in (response as Record<string, unknown>) &&
          !("stdout" in (response as Record<string, unknown>))
        ) {
          const e = (response as { error: unknown }).error;
          reject(new Error(typeof e === "string" ? e : String(e)));
          return;
        }
        resolve(response as T);
      })
      .catch((err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
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
