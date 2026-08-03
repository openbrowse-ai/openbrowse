import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { createArtifactStore, type ArtifactStore } from "./artifacts/store";
import { buildConfig, type Config } from "./config";
import { loadOrCreateKeyPair, type BrokerKeyPair } from "./keys/store";
import { createClientRegistry, type ClientRegistry } from "./oauth/clients";
import { createCodeStore, type CodeStore } from "./oauth/codes";
import { createPendingConsents, type PendingConsents } from "./oauth/pending-consents";
import { createRateLimiter, DEFAULT_RATE_LIMITS } from "./oauth/rate-limit";
import {
    createRefreshTokenStore,
    type RefreshTokenStore,
} from "./oauth/refresh-tokens";
import { handleArtifact } from "./routes/artifact";
import { handleAuthorize } from "./routes/authorize";
import { buildJwks } from "./routes/jwks";
import { handleMcp, type RpcForwarder } from "./routes/mcp";
import { handleRegister } from "./routes/register";
import { handleToken } from "./routes/token";
import {
    wellKnownAuthorizationServer,
    wellKnownProtectedResource,
} from "./routes/well-known";
import { createRpcForwarder } from "./ws/rpc";
import { attachWsServer } from "./ws/server";
import { SessionRegistry } from "./ws/session";

export interface ServerOptions {
  port?: number;
  rpcForwarder?: RpcForwarder;
  /**
   * Interval (ms) for the extension session heartbeat/liveness ping.
   * Forwarded to `attachWsServer`; mainly overridden by tests to drive
   * dead-peer eviction quickly. Defaults to 20s.
   */
  heartbeatIntervalMs?: number;
}

export interface RunningServer {
  port: number;
  baseUrl: string;
  cfg: Config;
  keys: BrokerKeyPair;
  clients: ClientRegistry;
  codes: CodeStore;
  pending: PendingConsents;
  refreshTokens: RefreshTokenStore;
  sessions: SessionRegistry;
  artifacts: ArtifactStore;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1 << 20; // 1 MiB

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string = "text/plain",
) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const NULL_FORWARDER: RpcForwarder = async (name) => {
  throw new Error(
    `tool ${name} not implemented — extension not connected (Phase 1 stub)`,
  );
};

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Per-path CORS allow-list. Replaces Phase 1's reflect-every-origin policy.
 *
 * - `/.well-known/*`, `/jwks`, `/register` — wire-public, `Allow-Origin: *`,
 *   no credentials.
 * - `/authorize` — loopback origins only (extension drives via content
 *   script, dev tools open at http://localhost:<port>).
 * - `/mcp` and `/artifact/<id>` — `chrome-extension://<id>` and loopback
 *   only; credentialed so the bearer token can ride along.
 * - `/token` and anything else — no CORS headers (POST from non-browser
 *   clients, no preflight needed).
 */
export function corsHeadersForPath(
  path: string,
  origin: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-authorization-server" ||
    path === "/jwks" ||
    path === "/register"
  ) {
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    return headers;
  }

  if (!origin) return headers;

  if (path === "/authorize") {
    if (LOOPBACK_ORIGIN_RE.test(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type";
    }
    return headers;
  }

  if (path === "/mcp" || path.startsWith("/artifact/")) {
    if (
      origin.startsWith("chrome-extension://") ||
      LOOPBACK_ORIGIN_RE.test(origin)
    ) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    return headers;
  }

  // /token and any other path: no CORS headers.
  return headers;
}

export async function startHttpServer(
  opts: ServerOptions = {},
): Promise<RunningServer> {
  // Validate the optional liveness interval up front. An invalid value
  // (NaN, zero, negative, fractional, or above Node's max timer delay)
  // would make the broker's heartbeat `setInterval` misbehave — busy-loop
  // for <=0/NaN, or get clamped to 1ms with a warning above 2^31-1.
  const { heartbeatIntervalMs } = opts;
  if (
    heartbeatIntervalMs !== undefined &&
    (!Number.isInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs <= 0 ||
      heartbeatIntervalMs > 2_147_483_647)
  ) {
    throw new RangeError(
      `heartbeatIntervalMs must be a positive integer <= 2147483647 ms, got ${heartbeatIntervalMs}`,
    );
  }
  const cfg = buildConfig({ port: opts.port });
  const keys = await loadOrCreateKeyPair();
  const clients = createClientRegistry();
  const codes = createCodeStore();
  const pending = createPendingConsents();
  const refreshTokens = await createRefreshTokenStore();
  const sessions = new SessionRegistry();
  const artifacts = createArtifactStore();
  // Periodically sweep expired artifacts so entries the owner never re-fetches
  // don't leak forever. `.unref()` so the interval doesn't keep Node alive.
  const sweepInterval = setInterval(() => artifacts.sweep(), 60_000);
  sweepInterval.unref();
  const rpcForwarder = opts.rpcForwarder ?? createRpcForwarder(sessions);
  const rateLimiter = createRateLimiter(DEFAULT_RATE_LIMITS);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${cfg.port}`);
    try {
      const path = url.pathname;
      const origin = req.headers.origin;
      const cors = corsHeadersForPath(path, origin);

      if (req.method === "OPTIONS") {
        if (Object.keys(cors).length > 0) {
          res.writeHead(204, { ...cors, "Access-Control-Max-Age": "600" });
        } else {
          res.writeHead(403);
        }
        return res.end();
      }

      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      if (path === "/.well-known/oauth-protected-resource" && req.method === "GET") {
        return sendJson(res, 200, wellKnownProtectedResource(cfg));
      }
      if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
        return sendJson(res, 200, wellKnownAuthorizationServer(cfg));
      }
      if (path === "/jwks" && req.method === "GET") {
        return sendJson(res, 200, buildJwks(keys.publicKey, keys.fingerprint));
      }
      if (path === "/register" && req.method === "POST") {
        const text = await readBody(req);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(text);
        } catch {
          return sendJson(res, 400, { error: "invalid_client_metadata" });
        }
        const r = handleRegister(body, clients);
        return sendJson(res, r.status, r.body);
      }
      if (path === "/authorize" && req.method === "GET") {
        const params = url.searchParams;
        const r = handleAuthorize({
          params: {
            client_id: params.get("client_id") ?? "",
            redirect_uri: params.get("redirect_uri") ?? "",
            response_type: params.get("response_type") ?? "",
            scope: params.get("scope") ?? "",
            state: params.get("state") ?? "",
            code_challenge: params.get("code_challenge") ?? "",
            code_challenge_method: params.get("code_challenge_method") ?? "",
            resource: params.get("resource") ?? "",
          },
          clients,
          pending,
          codes,
          // Phase 2: extension content script handles consent. Phase 1's
          // auto-approve fallback is preserved only for spike-equivalent
          // debugging via an explicit `?autoapprove=1` query parameter.
          autoApprove: params.get("autoapprove") === "1",
        });
        if (r.kind === "html") return sendText(res, 200, r.body, "text/html; charset=utf-8");
        if (r.kind === "error_page")
          return sendText(res, r.status, r.body, "text/html; charset=utf-8");
        if (r.kind === "redirect") {
          res.writeHead(r.status, { Location: r.location, "Cache-Control": "no-store" });
          return res.end();
        }
        return sendText(res, r.status, r.message);
      }
      if (path === "/token" && req.method === "POST") {
        const text = await readBody(req);
        const r = handleToken({
          body: new URLSearchParams(text),
          codes,
          clients,
          refreshTokens,
          privateKey: keys.privateKey,
          kid: keys.fingerprint,
          cfg,
        });
        return sendJson(res, r.status, r.body);
      }
      if (path === "/mcp" && (req.method === "POST" || req.method === "GET")) {
        const text = req.method === "POST" ? await readBody(req) : "{}";
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
        }
        // Tie the upstream RPC call to the request lifecycle so a disconnected
        // client can cancel an in-flight tool call (Phase 2 NULL_FORWARDER ignores).
        const ac = new AbortController();
        req.on("close", () => ac.abort());
        const forwarderWithSignal: RpcForwarder = async (name, args, ctx) => {
          const raw = await rpcForwarder(name, args, { ...ctx, signal: ac.signal });

          // Post-process: if the extension returned a recognizable artifact
          // payload (`{contentType, filename, base64}`), stash the bytes in
          // the artifact store and hand the MCP host a URL reference
          // instead. Keeps the host-facing tool result small even for
          // large screenshots, and isolates each artifact by owner client.
          //
          // Shapes WITHOUT `base64` (read_page, list_windows, get_context,
          // …) pass through unchanged.
          const r = raw as Record<string, unknown> | null;
          if (
            r &&
            typeof r === "object" &&
            typeof r["base64"] === "string" &&
            typeof r["contentType"] === "string"
          ) {
            const bytes = Buffer.from(r["base64"] as string, "base64");
            const filename = typeof r["filename"] === "string" ? r["filename"] : undefined;
            const id = artifacts.put({
              ownerClientId: ctx.sub,
              contentType: r["contentType"] as string,
              bytes,
              filename,
            });
            return {
              artifactUrl: `${cfg.issuer}/artifact/${id}`,
              contentType: r["contentType"],
              filename: filename ?? null,
              bytes: bytes.length,
            };
          }
          return raw;
        };
        const r = await handleMcp({
          method: req.method ?? "POST",
          headers,
          bodyText: text,
          cfg,
          publicKey: keys.publicKey,
          rpcForwarder: forwarderWithSignal,
          rateLimiter,
        });
        res.writeHead(r.status, r.headers);
        return res.end(r.bodyText);
      }
      if (path.startsWith("/artifact/") && req.method === "GET") {
        const artifactId = path.slice("/artifact/".length);
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
        }
        const r = await handleArtifact({
          id: artifactId,
          headers,
          cfg,
          publicKey: keys.publicKey,
          store: artifacts,
        });
        res.writeHead(r.status, r.headers);
        if (r.bodyBytes) return res.end(r.bodyBytes);
        return res.end(r.bodyText ?? "");
      }
      if (path === "/" && req.method === "GET") {
        return sendText(
          res,
          200,
          `OpenBrowse MCP\n\nIssuer: ${cfg.issuer}\nResource: ${cfg.resource}\nKey fingerprint: ${keys.fingerprint}\n`,
        );
      }
      return sendText(res, 404, `Not found: ${path}`);
    } catch (err) {
      if (!res.headersSent)
        sendJson(res, 500, { error: "internal_error", message: (err as Error).message });
    }
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(cfg.port, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : cfg.port;
      resolve(actualPort);
    });
  });

  const baseUrl = `http://localhost:${port}`;
  const wss = attachWsServer({
    httpServer: server,
    publicKeyFingerprint: keys.fingerprint,
    privateKey: keys.privateKey,
    brokerVersion: "0.0.0",
    registry: sessions,
    refreshTokens,
    ...(heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs } : {}),
  });
  return {
    port,
    baseUrl,
    cfg: { ...cfg, port, issuer: baseUrl, resource: `${baseUrl}/mcp` },
    keys,
    clients,
    codes,
    pending,
    refreshTokens,
    sessions,
    artifacts,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweepInterval);
        // Terminate any live extension sockets first so `server.close()`
        // isn't left waiting on upgraded WebSocket connections, then
        // release the WS server before shutting the HTTP server down.
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          server.close(() => resolve());
        });
      }),
  };
}
