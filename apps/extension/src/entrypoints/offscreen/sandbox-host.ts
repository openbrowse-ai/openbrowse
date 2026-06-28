/**
 * Offscreen-side handler for the SW-host's `SANDBOX_EXECUTE` message.
 *
 * The SW runs the agent loop but has no DOM, so `executeCode`'s
 * iframe-driven sandbox cannot live there. This handler bridges the
 * call: the SW posts a `SANDBOX_EXECUTE` payload via
 * `chrome.runtime.sendMessage`, the offscreen document's message
 * listener (`entrypoints/offscreen/main.ts`) routes it here, and we
 * run `executeInSandboxLocal` against the offscreen page's iframe.
 *
 * The offscreen `<iframe src="sandbox.html">` is the same artifact the
 * renderer used to instantiate; it survives across calls (the
 * `ensureSandbox` in `tools/sandbox.ts` caches the frame at module
 * scope), so a long-running run does not pay iframe-creation cost on
 * every `executeCode` invocation.
 */

import {
  executeInSandboxLocal,
  type ExecuteCodeResult,
} from "@/lib/agent/tools/sandbox";

export interface SandboxExecutePayload {
  target: "offscreen";
  type: "SANDBOX_EXECUTE";
  code: string;
  input?: unknown;
  options?: {
    unboundedOutput?: boolean;
    timeoutMs?: number;
  };
}

export function isSandboxExecutePayload(x: unknown): x is SandboxExecutePayload {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.target === "offscreen" &&
    o.type === "SANDBOX_EXECUTE" &&
    typeof o.code === "string"
  );
}

/**
 * Invoke the offscreen-local sandbox executor. Always resolves; transport
 * errors are encoded in the result rather than thrown so the SW caller
 * can treat both transport and sandbox errors uniformly.
 */
export async function handleSandboxExecute(
  payload: SandboxExecutePayload,
): Promise<ExecuteCodeResult> {
  try {
    return await executeInSandboxLocal(payload.code, payload.input, payload.options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, logs: [] };
  }
}
