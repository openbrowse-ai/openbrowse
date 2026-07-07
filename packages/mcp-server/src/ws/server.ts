import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  isHelloResponse,
  isRevokeHost,
  type HelloChallengeMessage,
  type HelloProofMessage,
  type HelloRejectMessage,
} from "./protocol";
import { SessionRegistry, type ExtensionSession } from "./session";
import type { RefreshTokenStore } from "../oauth/refresh-tokens";

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
}

export function attachWsServer(opts: AttachOpts): WebSocketServer {
  const { httpServer, publicKeyFingerprint, privateKey, brokerVersion, registry, refreshTokens } = opts;
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

    const helloTimeout = setTimeout(() => {
      ws.close(4000, "hello timeout");
    }, 5000);

    ws.once("message", (raw) => {
      clearTimeout(helloTimeout);
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        ws.close(4001, "invalid JSON");
        return;
      }
      if (!isHelloResponse(msg)) {
        ws.close(4002, "expected hello-response");
        return;
      }
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
      const signature = sign(null, Buffer.from(`${nonce}.${sessionId}`), privateKey).toString(
        "base64url",
      );
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

      // Heartbeat: send periodic pings to keep the extension's MV3
      // service worker alive. Incoming WS data counts as an event that
      // resets Chrome's idle timer, preventing the SW from being killed.
      const HEARTBEAT_INTERVAL_MS = 20_000;
      const heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        }
      }, HEARTBEAT_INTERVAL_MS);

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
    });
  });

  return wss;
}
