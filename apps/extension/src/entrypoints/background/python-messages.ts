/**
 * PYTHON_* RPC handler shared between the chrome.runtime.onMessage
 * listener (renderer → SW path) and the in-process `swRpc` dispatch
 * (SW → SW path, when the SW-hosted agent loop invokes
 * `executePythonRPC` from `@/lib/python/messages`).
 *
 * Background: `chrome.runtime.sendMessage` is NOT delivered back to
 * the sender's own listeners. The SW therefore cannot use plain
 * `sendMessage` to talk to its own PYTHON handler — the message
 * would land only in the offscreen document, whose listener guards
 * on `message.target === "offscreen"` and silently ignores it. The
 * port then closes with no response, surfacing in chat as
 * "Error (Internal): The message port closed before a response was
 * received."
 *
 * The handler ensures the offscreen document exists, forwards the
 * envelope to it with the required `target: "offscreen"` field, and
 * relays the response back through the `sendResponse` callback.
 * Idempotent + side-effect-free outside of those two responsibilities.
 *
 * The debug breadcrumb log is preserved verbatim (writes a rolling
 * ring buffer to `chrome.storage.local.__python_debug_log__`) because
 * crashing Pyodide worker investigations rely on it.
 */

import type { SwHandler } from "@/lib/runtime/sw-rpc";

export interface PythonRpcMessage {
  type: string;
  conversationId?: string;
  [key: string]: unknown;
}

export type PythonRpcResponse = unknown;

function persistBreadcrumb(
  conversationId: unknown,
  event: string,
  data?: unknown,
): void {
  try {
    void chrome.storage.local.get("__python_debug_log__").then((cur) => {
      const arr = Array.isArray(cur.__python_debug_log__)
        ? (cur.__python_debug_log__ as unknown[])
        : [];
      arr.push({
        ts: Date.now(),
        conversationId: typeof conversationId === "string" ? conversationId : "(none)",
        event: `bg.${event}`,
        data,
      });
      // Cap at 200 to avoid unbounded growth across long sessions.
      while (arr.length > 200) arr.shift();
      void chrome.storage.local.set({ __python_debug_log__: arr });
    });
  } catch {
    /* noop */
  }
}

export const handlePythonMessage: SwHandler<PythonRpcMessage, PythonRpcResponse> = (
  message,
  sendResponse,
) => {
  void (async () => {
    persistBreadcrumb(message.conversationId, "PYTHON_received", {
      type: message.type,
    });
    try {
      const { ensureOffscreenDocument } = await import("./messages");
      await ensureOffscreenDocument();
      persistBreadcrumb(message.conversationId, "offscreen-ensured");

      const { sendToOffscreen } = await import("@/lib/messages");
      // Drop both `type` (re-passed below) AND `target` (which
      // `sendToOffscreen` sets authoritatively). Without dropping
      // `target`, any inbound `target` field would clobber the
      // offscreen destination set by `sendToOffscreen`.
      const { type, target: _target, ...rest } = message as PythonRpcMessage & {
        target?: string;
      };
      void _target;
      const result = await sendToOffscreen({
        type,
        ...rest,
      } as Parameters<typeof sendToOffscreen>[0]);

      persistBreadcrumb(message.conversationId, "offscreen-responded", {
        hasResult: result !== undefined,
        keys:
          result && typeof result === "object"
            ? Object.keys(result as Record<string, unknown>)
            : null,
      });

      sendResponse(result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      persistBreadcrumb(message.conversationId, "error", { error });
      sendResponse({ error });
    }
  })();
  return true;
};
