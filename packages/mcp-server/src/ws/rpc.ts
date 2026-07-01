import { randomBytes } from "node:crypto";
import { isRpcResult, isRpcError, type RpcRequestMessage } from "./protocol";
import type { SessionRegistry } from "./session";
import type { RpcForwarder } from "../routes/mcp";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Per-method ceilings for the broker → extension RPC. Most tools
 * complete synchronously well within the default 30s.
 *
 * Long-running exceptions:
 *  - `task`: returns within ~1s after consent, but consent itself can
 *    take up to ~60s (`AUTO_DENY_MS`). 90s of headroom keeps the
 *    user-waits-to-click-Allow case from tripping a misleading
 *    `rpc_timeout`.
 *  - `task_wait`: blocks server-side until the task reaches a
 *    terminal status or its own `timeoutMs` elapses (caller-supplied,
 *    capped at 900_000 = 15 min). The broker ceiling sits a few
 *    seconds above that cap so the WS layer never kills a legitimate
 *    wait before the extension's timer fires.
 */
const PER_METHOD_TIMEOUT_MS: Partial<Record<string, number>> = {
  task: 90_000,
  task_wait: 905_000,
};

export function createRpcForwarder(
  registry: SessionRegistry,
  opts: { timeoutMs?: number } = {},
): RpcForwarder {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    abortHandler?: () => void;
    signal?: AbortSignal;
  }>();

  // Lazily attach the message listener the first time we get a session.
  function ensureListener(): void {
    const session = registry.getSession();
    if (!session) return;
    const ws = session.ws as unknown as { on: (event: string, fn: (...args: unknown[]) => void) => void };
    const tagged = ws as unknown as { __mcpRpcAttached?: boolean };
    if (tagged.__mcpRpcAttached) return;
    tagged.__mcpRpcAttached = true;
    ws.on("message", (raw: unknown) => {
      let msg: unknown;
      try {
        msg = JSON.parse((raw as Buffer | string).toString());
      } catch {
        return;
      }
      if (isRpcResult(msg)) {
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          if (p.signal && p.abortHandler) {
            p.signal.removeEventListener("abort", p.abortHandler);
          }
          pending.delete(msg.id);
          p.resolve(msg.result);
        }
      } else if (isRpcError(msg)) {
        const p = pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          if (p.signal && p.abortHandler) {
            p.signal.removeEventListener("abort", p.abortHandler);
          }
          pending.delete(msg.id);
          p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        }
      }
    });
  }

  return async function forward(toolName, args, authContext) {
    const session = registry.getSession();
    if (!session) {
      throw new Error("extension_not_connected: OpenBrowse extension is not connected to the MCP broker");
    }
    ensureListener();
    const id = randomBytes(12).toString("base64url");
    const request: RpcRequestMessage = {
      type: "rpc",
      id,
      hostInfo: { name: authContext.client_name ?? authContext.sub, version: "" },
      method: toolName as RpcRequestMessage["method"],
      params: args,
    };

    return new Promise((resolve, reject) => {
      const perMethodMs = PER_METHOD_TIMEOUT_MS[toolName] ?? timeoutMs;
      const timer = setTimeout(() => {
        const p = pending.get(id);
        if (p?.signal && p.abortHandler) {
          p.signal.removeEventListener("abort", p.abortHandler);
        }
        pending.delete(id);
        reject(new Error(`rpc_timeout: ${toolName} timed out after ${perMethodMs}ms`));
      }, perMethodMs);

      const entry: {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
        abortHandler?: () => void;
        signal?: AbortSignal;
      } = {
        resolve,
        reject,
        timer,
        signal: authContext.signal,
        abortHandler: undefined,
      };

      // Honor AbortSignal: clean up and reject if the upstream HTTP request
      // is cancelled (Task 9 wires this).
      if (authContext.signal) {
        const abortHandler = () => {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`rpc_aborted: ${toolName} aborted by caller`));
        };
        entry.abortHandler = abortHandler;
        // Pre-aborted signal — fire synchronously, but use queueMicrotask so
        // we've finished registering the entry first.
        if (authContext.signal.aborted) {
          queueMicrotask(abortHandler);
        } else {
          authContext.signal.addEventListener("abort", abortHandler, { once: true });
        }
      }

      pending.set(id, entry);
      (session.ws as unknown as { send: (data: string) => void }).send(JSON.stringify(request));
    });
  };
}
