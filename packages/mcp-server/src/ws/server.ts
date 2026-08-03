import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { RefreshTokenStore } from "../oauth/refresh-tokens";
import {
    PROTOCOL_VERSION,
    isHelloDefer,
    isHelloResponse,
    isRevokeHost,
    type HelloChallengeMessage,
    type HelloProofMessage,
    type HelloRejectMessage,
} from "./protocol";
import { SessionRegistry, type ExtensionSession } from "./session";

/**
 * SHA-256 of the broker binary, computed once at module load.
 *
 * Sent in `hello-challenge.binarySha256` so the extension can pin it on first
 * TOFU and warn the user on later reconnects when it changes (likely cause:
 * the user upgraded the broker; less likely but worth surfacing: the binary
 * was replaced behind their back).
 *
 * Best-effort and advisory — we never block a connection on a mismatch. If
 * `process.execPath` is unreadable for any reason (Snap/AppImage layering,
 * single-file binary in a read-only mount, EACCES, ...) we just omit the
 * field and the extension treats it as "no signal".
 */
const BINARY_SHA256 = ((): string | undefined => {
  try {
    const buf = readFileSync(process.execPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return undefined;
  }
})();

export interface AttachOpts {
  httpServer: Server;
  publicKeyFingerprint: string;
  privateKey: KeyObject;
  brokerVersion: string;
  registry: SessionRegistry;
  /**
   * Refresh-token store the server uses to honor `revoke-host`
   * messages from the extension. Optional only so the legacy test
   * setup that doesn't yet plumb a store keeps working — production
   * callers in `server.ts` always pass one through.
   */
  refreshTokens?: RefreshTokenStore;
  /**
   * How often (ms) the broker pings an established session's socket to
   * both keep the MV3 service worker alive and detect a dead peer. A
   * socket that misses a full interval without a pong is terminated so
   * its session is cleared and the extension can re-pair. Defaults to
   * 20s; overridable mainly so tests can drive eviction quickly.
   */
  heartbeatIntervalMs?: number;
}

export function attachWsServer(opts: AttachOpts): WebSocketServer {
  const {
    httpServer,
    publicKeyFingerprint,
    privateKey,
    brokerVersion,
    registry,
    refreshTokens,
    heartbeatIntervalMs = 20_000,
  } = opts;
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://localhost`);
    if (url.pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    const nonce = randomBytes(32).toString("base64url");
    const challenge: HelloChallengeMessage = {
      type: "hello-challenge",
      protocolVersion: PROTOCOL_VERSION,
      brokerVersion,
      publicKeyFingerprint,
      processInfo: {
        pid: process.pid,
        executablePath: process.execPath,
        startedAt: Date.now() - Math.floor(process.uptime() * 1000),
      },
      nonce,
      binarySha256: BINARY_SHA256,
    };
    ws.send(JSON.stringify(challenge));

    // Handshake timers.
    //
    // `helloTimer` fast-fails a dead or hung extension that never answers
    // the challenge. But first-run TOFU (and key-rotation) require a
    // *human* to approve the broker's identity in the extension UI, which
    // can't happen in 5s. When the extension signals `hello-defer`, we
    // swap the short timeout for a much longer `trustTimer` so the socket
    // stays open while the user decides. Without this, the socket is torn
    // down every few seconds and the extension's trust prompt flickers in
    // an endless reconnect loop.
    const HELLO_TIMEOUT_MS = 5_000;
    const TRUST_DECISION_TIMEOUT_MS = 5 * 60_000;
    let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      ws.close(4000, "hello timeout");
    }, HELLO_TIMEOUT_MS);
    let trustTimer: ReturnType<typeof setTimeout> | null = null;

    function clearHandshakeTimers(): void {
      if (helloTimer !== null) {
        clearTimeout(helloTimer);
        helloTimer = null;
      }
      if (trustTimer !== null) {
        clearTimeout(trustTimer);
        trustTimer = null;
      }
    }

    // Drop the handshake timers if the socket closes before the handshake
    // finishes (e.g. the user declined the trust prompt). Registered with
    // `once` so it never lingers past a single close.
    ws.once("close", clearHandshakeTimers);

    // The handshake listener is a persistent `on` (not `once`) because a
    // `hello-defer` may precede the real `hello-response`. It removes
    // itself with `ws.off` before the post-handshake control listener is
    // attached, so later messages (e.g. `revoke-host`) don't fall through
    // to the "expected hello-response" path.
    function onHandshakeMessage(raw: RawData): void {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        clearHandshakeTimers();
        ws.close(4001, "invalid JSON");
        return;
      }

      // Extension is asking a human to approve us. Hold the connection
      // open (bounded by a generous timeout) until it either sends
      // `hello-response` (approved) or drops the socket (declined).
      if (isHelloDefer(msg)) {
        if (helloTimer !== null) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
        if (trustTimer === null) {
          trustTimer = setTimeout(() => {
            ws.close(4005, "trust decision timeout");
          }, TRUST_DECISION_TIMEOUT_MS);
        }
        return;
      }

      if (!isHelloResponse(msg)) {
        clearHandshakeTimers();
        ws.close(4002, "expected hello-response");
        return;
      }
      clearHandshakeTimers();
      ws.off("message", onHandshakeMessage);
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        const reject: HelloRejectMessage = {
          type: "hello-reject",
          reason: "protocol_version_unsupported",
          brokerProtocolVersions: [PROTOCOL_VERSION],
          brokerVersion,
        };
        ws.send(JSON.stringify(reject));
        ws.close(4003);
        return;
      }
      // Enforce a single active extension session. If one already exists,
      // reject the newcomer rather than stealing the session — otherwise
      // two live extensions (e.g. two Chrome profiles pointed at the same
      // broker) would ping-pong takeovers every reconnect. The rejected
      // side retries on its own backoff; whichever paired first stays
      // connected.
      if (registry.hasActiveSession()) {
        const reject: HelloRejectMessage = {
          type: "hello-reject",
          reason: "session_already_active",
          brokerProtocolVersions: [PROTOCOL_VERSION],
          brokerVersion,
        };
        ws.send(JSON.stringify(reject));
        ws.close(4004);
        return;
      }

      const sessionId = randomBytes(16).toString("base64url");
      const signature = sign(
        null,
        Buffer.from(`${nonce}.${sessionId}`),
        privateKey,
      ).toString("base64url");
      const proof: HelloProofMessage = {
        type: "hello-proof",
        signature,
        sessionId,
      };
      ws.send(JSON.stringify(proof));

      const session: ExtensionSession = {
        ws,
        sessionId,
        extensionVersion: msg.extensionVersion,
        capabilities: msg.capabilities,
        connectedAt: Date.now(),
      };
      registry.setSession(session);

      // Heartbeat + liveness.
      //
      // The app-level `{type:"ping"}` keeps the extension's MV3 service
      // worker alive: an incoming WS message resets Chrome's idle timer.
      //
      // The WebSocket-level `ws.ping()` detects a *dead* peer. A single
      // extension whose socket dies uncleanly (SW crash, sleep/wake,
      // network blip — no TCP FIN) would otherwise keep its session
      // registered here, and because the broker enforces a single session
      // the extension's reconnect would be rejected with
      // `session_already_active` until the OS TCP stack finally times the
      // dead socket out (minutes). Instead we require a pong each
      // interval; a socket that misses one is terminated, which fires the
      // `close` handler below, clears the session, and lets the extension
      // re-pair within ~one interval.
      let isAlive = true;
      ws.on("pong", () => {
        isAlive = true;
      });
      const heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!isAlive) {
          // No pong since the previous tick — treat the peer as gone.
          ws.terminate();
          return;
        }
        isAlive = false;
        try {
          ws.ping();
        } catch {
          // Socket may have died between the readyState check and here.
        }
        ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      }, heartbeatIntervalMs);

      // Phase 3 / Task 11: handle post-handshake server-bound messages.
      // The RPC forwarder (ws/rpc.ts) attaches its own listener for
      // `rpc-result`/`rpc-error`; we attach an additional non-`once`
      // listener here to react to broker-control messages from the
      // extension. Currently only `revoke-host` — when the user blocks
      // a host in the settings UI, the extension forwards that here
      // and we delete all refresh tokens for that clientId so the next
      // call must go through a fresh consent flow.
      //
      // Caller identity is not authenticated beyond "extension is
      // connected"; any connected extension may revoke any client.
      // Phase 4 may tighten this (e.g. require a signed envelope).
      ws.on("message", (controlRaw) => {
        let controlMsg: unknown;
        try {
          controlMsg = JSON.parse(controlRaw.toString("utf8"));
        } catch {
          return;
        }
        if (isRevokeHost(controlMsg)) {
          // Best-effort: a missing store (legacy test setup) or a
          // failed delete shouldn't crash the WS server.
          if (refreshTokens) {
            refreshTokens.revokeClient(controlMsg.clientId).catch(() => {});
          }
          return;
        }
      });

      ws.on("close", () => {
        clearInterval(heartbeat);
        if (registry.getSession()?.sessionId === sessionId) {
          registry.clearSession();
        }
      });
    }

    ws.on("message", onHandshakeMessage);
  });

  return wss;
}
