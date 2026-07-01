import type { KeyObject } from "node:crypto";
import { verifyJwt } from "../oauth/jwt";
import type { Config } from "../config";
import { ALL_TOOLS, TOOL_SCOPES, type ToolName } from "../mcp/tools";
import type { RateBucket, RateLimiter } from "../oauth/rate-limit";

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export type RpcForwarder = (
  toolName: string,
  args: unknown,
  authContext: { sub: string; client_name?: string; scope?: string; signal?: AbortSignal },
) => Promise<unknown>;

export interface HandleMcpArgs {
  method: string;
  headers: Record<string, string | undefined>;
  bodyText: string;
  cfg: Config;
  publicKey: KeyObject;
  rpcForwarder: RpcForwarder;
  rateLimiter: RateLimiter;
}

function jsonResponse(status: number, body: unknown): McpResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "Content-Type": "application/json" },
    bodyText: text,
  };
}

function unauthorized(cfg: Config, error?: string): McpResponse {
  let www = `Bearer realm="OpenBrowse MCP", resource="${cfg.resource}", resource_metadata="${cfg.issuer}/.well-known/oauth-protected-resource"`;
  if (error) www += `, error="${error}"`;
  return {
    status: 401,
    headers: { "WWW-Authenticate": www, "Content-Type": "application/json" },
    bodyText: JSON.stringify({ error: "unauthorized", error_description: error ?? "missing or invalid Bearer" }),
  };
}

export async function handleMcp(args: HandleMcpArgs): Promise<McpResponse> {
  const { headers, bodyText, cfg, publicKey, rpcForwarder, rateLimiter } = args;
  const authHeader = headers.authorization ?? headers.Authorization;
  if (!authHeader) return unauthorized(cfg);

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return unauthorized(cfg, "invalid_token");

  const verification = verifyJwt(match[1], publicKey, { audience: cfg.resource });
  if (!verification.valid) return unauthorized(cfg, verification.reason);

  let rpc: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try {
    rpc = JSON.parse(bodyText);
  } catch {
    return jsonResponse(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }

  const authContext = {
    sub: verification.payload.sub,
    client_name: verification.payload.client_name as string | undefined,
    scope: verification.payload.scope as string | undefined,
  };

  switch (rpc.method) {
    case "initialize": {
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "openbrowse-mcp", version: "0.0.0" },
        },
      });
    }
    case "tools/list": {
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { tools: ALL_TOOLS },
      });
    }
    case "tools/call": {
      const params = (rpc.params ?? {}) as { name?: string; arguments?: unknown };
      if (!params.name) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32602, message: "missing tool name" },
        });
      }
      // Enforce per-tool scope. The granted scopes live in the JWT's `scope`
      // claim (space-separated). If a token was issued with `scope: "read_page"`
      // and the host now tries to call `task`, we refuse: the user only consented
      // to the narrower capability. Tokens minted without a `scope` claim
      // therefore cannot invoke any tool — by design.
      const grantedScopes = (verification.payload.scope as string | undefined)
        ?.split(/\s+/)
        .filter(Boolean) ?? [];
      const requiredScope = TOOL_SCOPES[params.name as ToolName];
      if (requiredScope && !grantedScopes.includes(requiredScope)) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32000,
            message: `insufficient_scope: tool '${params.name}' requires scope '${requiredScope}' but token was granted scopes: ${grantedScopes.join(", ") || "(none)"}`,
          },
        });
      }
      const bucket: RateBucket = params.name === "task" ? "task" : "read";
      const consumed = rateLimiter.tryConsume(verification.payload.sub, bucket);
      if (consumed === "rate_limited") {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32000,
            message: `rate_limited: too many ${bucket} calls. Try again later.`,
          },
        });
      }
      const dispatch = async () => {
        try {
          const toolResult = await rpcForwarder(params.name!, params.arguments ?? {}, authContext);
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              content: [
                { type: "text", text: JSON.stringify(toolResult, null, 2) },
              ],
            },
          });
        } catch (err) {
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32603, message: (err as Error).message },
          });
        }
      };
      if (params.name === "task") {
        const started = rateLimiter.startTask(verification.payload.sub);
        if (started === "concurrent_limit") {
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            error: {
              code: -32000,
              message: "concurrent_limit: another task is already in flight from this host.",
            },
          });
        }
        try {
          return await dispatch();
        } finally {
          rateLimiter.endTask(verification.payload.sub);
        }
      }
      return await dispatch();
    }
    case "notifications/initialized":
    case "notifications/cancelled": {
      return { status: 202, headers: {}, bodyText: "" };
    }
    default: {
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `method not found: ${rpc.method}` },
      });
    }
  }
}
