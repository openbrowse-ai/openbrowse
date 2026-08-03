import {
  isHelloChallenge,
  isHelloProof,
  isHelloReject,
  isRpcRequest,
  PROTOCOL_VERSION,
  type HelloResponseMessage,
  type RpcRequestMessage,
} from "./protocol";
import {
  getTrustedFingerprint,
  getTrustRecord,
  trustBroker,
  type TrustRecord,
} from "./tofu";

/**
 * Shared per-request handler context. Phase 1 handlers ignore it; the
 * Phase 2 `task` handler uses `emitEvent` to stream `task-event`
 * notifications back to the broker (and thus to the originating MCP
 * host as MCP progress notifications).
 */
export interface RpcHandlerContext {
  authContext: { sub: string; client_name?: string; scope?: string };
  /** Emit a `task-event` for this RPC (only meaningful for the `task` handler). */
  emitEvent: (event: unknown) => void;
}

export interface ConnectOptions {
  url: string;
  onTofuPrompt?: (info: {
    fingerprint: string;
    processInfo: TrustRecord["processInfo"];
    nonce: string;
    binarySha256?: string;
  }) => void;
  onKeyMismatch?: (info: {
    storedFingerprint: string;
    presentedFingerprint: string;
  }) => void;
  /**
   * Called when the broker's `binarySha256` differs from the value stored
   * at TOFU time. Advisory only — the connection is NOT blocked. Both
   * sides must have a binary hash for this to fire; if either is missing,
   * we treat it as "no signal" and stay quiet.
   */
  onBinaryDrift?: (info: { stored: string; presented: string }) => void;
  /**
   * Fires once `hello-proof` is received and the handshake is
   * complete. `info` carries the broker's self-reported version and
   * the session id assigned by the broker — both needed by the
   * settings UI for the "Connected" view.
   */
  onConnected?: (info: { brokerVersion: string; sessionId: string }) => void;
  onDisconnected?: () => void;
}

export interface BrokerConnection {
  start(): Promise<void>;
  stop(): void;
  /** Used after TOFU prompt: user clicked "Trust" — complete the handshake. */
  acceptTofu(): Promise<void>;
  /** Used after TOFU prompt: user clicked "Cancel" — refuse. */
  declineTofu(): void;
  /** Phase 2: expose the underlying WS for consent message forwarding. Null until connected. */
  getWebSocket(): WebSocket | null;
}

export function connectToBroker(opts: ConnectOptions): BrokerConnection {
  let ws: WebSocket | null = null;
  let pendingChallenge: {
    fingerprint: string;
    processInfo: TrustRecord["processInfo"];
    nonce: string;
    binarySha256?: string;
  } | null = null;
  /**
   * Most recent broker version seen in a `hello-challenge`. Cached so
   * that when `hello-proof` arrives we can include it in the
   * `onConnected` payload — `hello-proof` itself doesn't repeat the
   * version. Updated on every challenge; never read until proof.
   */
  let lastBrokerVersion: string | null = null;

  function sendHelloResponse(socket: WebSocket): void {
    const manifest = chrome.runtime.getManifest();
    const msg: HelloResponseMessage = {
      type: "hello-response",
      protocolVersion: PROTOCOL_VERSION,
      extensionVersion: manifest.version,
      capabilities: {
        tools: [
          "get_context",
          "list_windows",
          "list_spaces",
          "read_page",
          "screenshot",
          "task",
          "cancel_task",
          "open_url",
        ],
        profile: "Default",
      },
    };
    socket.send(JSON.stringify(msg));
  }

  /**
   * Tell the broker we can't answer the challenge yet because a human
   * must approve its identity (first-run TOFU or key-rotation mismatch).
   * This cancels the broker's short hello-timeout so the socket stays
   * open while the user decides — without it the connection is torn down
   * every few seconds and the trust prompt flickers in a reconnect loop.
   */
  function sendHelloDefer(socket: WebSocket): void {
    socket.send(
      JSON.stringify({ type: "hello-defer", reason: "awaiting_user_trust" }),
    );
  }

  async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Broker heartbeat — no action needed; the incoming WS data event
    // already reset the MV3 idle timer.
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { type: unknown }).type === "ping"
    ) {
      return;
    }

    if (isHelloChallenge(msg)) {
      lastBrokerVersion = msg.brokerVersion;
      const trusted = await getTrustedFingerprint();
      if (trusted === null) {
        // First-time TOFU prompt. Tell the broker to hold the socket
        // open while we wait for the user's trust decision.
        pendingChallenge = {
          fingerprint: msg.publicKeyFingerprint,
          processInfo: msg.processInfo,
          nonce: msg.nonce,
          binarySha256: msg.binarySha256,
        };
        sendHelloDefer(socket);
        opts.onTofuPrompt?.(pendingChallenge);
        return;
      }
      if (trusted !== msg.publicKeyFingerprint) {
        // Key rotation / mismatch also needs a human decision, so defer
        // to keep the socket alive rather than letting it time out.
        sendHelloDefer(socket);
        opts.onKeyMismatch?.({
          storedFingerprint: trusted,
          presentedFingerprint: msg.publicKeyFingerprint,
        });
        return;
      }
      // Trusted fingerprint match. Check for binary drift (advisory).
      //
      // Only fires when BOTH sides have a hash. A stored record without
      // `binarySha256` (older TOFU) silently stays trusted, and a current
      // hello-challenge without `binarySha256` (broker couldn't read its
      // own execPath) also stays quiet — we don't want false alarms.
      if (msg.binarySha256 !== undefined) {
        const record = await getTrustRecord();
        if (
          record?.binarySha256 !== undefined &&
          record.binarySha256 !== msg.binarySha256
        ) {
          opts.onBinaryDrift?.({
            stored: record.binarySha256,
            presented: msg.binarySha256,
          });
          // Do NOT return — drift is advisory only. Continue with handshake.
        }
      }
      sendHelloResponse(socket);
      return;
    }

    if (isHelloReject(msg)) {
      opts.onDisconnected?.();
      socket.close();
      return;
    }

    if (isHelloProof(msg)) {
      // Note: full signature verification (RPC-grade) is deferred to a future
      // task. For Phase 1, presence of hello-proof signals successful handshake.
      //
      // `lastBrokerVersion` is set during the matching `hello-challenge`
      // earlier in the same WS lifecycle. A proof without a prior
      // challenge is malformed; we fall back to an empty string rather
      // than throwing because the UI tolerates it gracefully.
      opts.onConnected?.({
        brokerVersion: lastBrokerVersion ?? "",
        sessionId: msg.sessionId,
      });
      return;
    }

    if (isRpcRequest(msg)) {
      await dispatchRpc(msg, socket.send.bind(socket), {
        // Phase 1 has no OAuth flow yet, so we use the host's
        // self-reported name as the subject (collisions across hosts
        // are therefore possible — tightened in Phase 3).
        sub: msg.hostInfo?.name ?? "unknown",
        client_name: msg.hostInfo?.name,
      });
      return;
    }
  }

  return {
    async start() {
      ws = new WebSocket(opts.url);
      ws.onopen = () => {
        /* awaiting hello-challenge */
      };
      ws.onmessage = (ev) => {
        void handleMessage(ws!, typeof ev.data === "string" ? ev.data : "");
      };
      ws.onclose = () => {
        opts.onDisconnected?.();
        ws = null;
      };
      ws.onerror = () => {
        opts.onDisconnected?.();
      };
    },
    stop() {
      ws?.close();
      ws = null;
    },
    async acceptTofu() {
      if (!pendingChallenge || !ws) return;
      await trustBroker({
        fingerprint: pendingChallenge.fingerprint,
        processInfo: pendingChallenge.processInfo,
        binarySha256: pendingChallenge.binarySha256,
      });
      sendHelloResponse(ws);
      pendingChallenge = null;
    },
    declineTofu() {
      pendingChallenge = null;
      ws?.close();
    },
    getWebSocket() {
      return ws;
    },
  };
}

/**
 * Map a thrown error to the audit-log `outcome` enum.
 *
 * Errors with `code === "user_denied"` or `code === "host_blocked"` are
 * user-initiated denials and recorded as `"denied"`. Everything else
 * (handler bugs, network failures, validation errors) is `"error"`.
 */
function outcomeFromError(err: unknown): "denied" | "error" {
  const code = (err as { code?: string }).code;
  return code === "user_denied" || code === "host_blocked" ? "denied" : "error";
}

/**
 * Dispatch a single RPC request and record an audit row for the outcome.
 *
 * Extracted as a named export so it can be unit-tested without standing
 * up a fake WebSocket. The audit append is awaited (not fire-and-forget)
 * so callers — including tests — observe the record before the response
 * is sent. The extra IDB write per RPC is acceptable: dispatch already
 * does network/CDP work that dwarfs an indexed-DB put.
 */
export async function dispatchRpc(
  msg: RpcRequestMessage,
  send: (data: string) => void,
  authContext: { sub: string; client_name?: string; scope?: string },
): Promise<void> {
  const emitEvent = (event: unknown) => {
    try {
      send(
        JSON.stringify({
          type: "task-event",
          id: msg.id,
          // The runner increments its own counter and includes it
          // in the event payload; the outer envelope keeps a 0
          // placeholder for protocol compatibility.
          step: 0,
          event,
        }),
      );
    } catch {
      // Socket may have closed; swallow.
    }
  };
  const handlerCtx: RpcHandlerContext = { authContext, emitEvent };

  const t0 = Date.now();
  const hostName = authContext.client_name ?? authContext.sub;

  async function recordAudit(args: {
    outcome: "ok" | "error" | "denied";
    errorCode?: string;
  }): Promise<void> {
    try {
      const { auditDb } = await import("@/lib/mcp-bridge-audit-db");
      // `seq` is the IDB primary key. We synthesise it from a millisecond
      // clock plus a small random suffix so two RPCs that complete in the
      // same millisecond don't collide on the keyPath.
      const seq = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      await auditDb.append({
        seq,
        ts: Date.now(),
        clientId: authContext.sub,
        hostName,
        method: msg.method,
        durationMs: Date.now() - t0,
        outcome: args.outcome,
        errorCode: args.errorCode,
      });
    } catch {
      // Audit failures must never break RPC dispatch.
    }
  }

  try {
    let result: unknown;
    switch (msg.method) {
      case "get_context": {
        const { handleGetContext } = await import("./handlers/get-context");
        result = await handleGetContext(msg.params, handlerCtx);
        break;
      }
      case "list_windows": {
        const { handleListWindows } = await import("./handlers/list-windows");
        result = await handleListWindows(msg.params, handlerCtx);
        break;
      }
      case "list_spaces": {
        const { handleListSpaces } = await import("./handlers/list-spaces");
        result = await handleListSpaces(msg.params, handlerCtx);
        break;
      }
      case "read_page": {
        const { handleReadPage } = await import("./handlers/read-page");
        result = await handleReadPage(msg.params, handlerCtx);
        break;
      }
      case "screenshot": {
        const { handleScreenshot } = await import("./handlers/screenshot");
        result = await handleScreenshot(msg.params, handlerCtx);
        break;
      }
      case "task": {
        const { handleTask } = await import("./handlers/task");
        result = await handleTask(msg.params, handlerCtx);
        break;
      }
      case "task_status": {
        const { handleTaskStatus } = await import("./handlers/task-status");
        result = await handleTaskStatus(msg.params, handlerCtx);
        break;
      }
      case "task_wait": {
        const { handleTaskWait } = await import("./handlers/task-wait");
        result = await handleTaskWait(msg.params, handlerCtx);
        break;
      }
      case "cancel_task": {
        const { handleCancelTask } = await import("./handlers/cancel-task");
        result = await handleCancelTask(msg.params, handlerCtx);
        break;
      }
      case "open_url": {
        const { handleOpenUrl } = await import("./handlers/open-url");
        result = await handleOpenUrl(msg.params, handlerCtx);
        break;
      }
      default:
        // Unknown methods don't get an audit row — they never reached a
        // handler. The error envelope still surfaces to the host.
        send(
          JSON.stringify({
            type: "rpc-error",
            id: msg.id,
            error: {
              code: "method_not_found",
              message: `unknown method: ${(msg as { method: string }).method}`,
            },
          }),
        );
        return;
    }
    await recordAudit({ outcome: "ok" });
    send(JSON.stringify({ type: "rpc-result", id: msg.id, result }));
  } catch (err) {
    const code = (err as { code?: string }).code ?? "internal_error";
    await recordAudit({ outcome: outcomeFromError(err), errorCode: code });
    send(
      JSON.stringify({
        type: "rpc-error",
        id: msg.id,
        error: { code, message: (err as Error).message },
      }),
    );
  }
}
