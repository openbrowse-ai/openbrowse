import type { KeyObject } from "node:crypto";
import { verifyJwt } from "../oauth/jwt";
import type { Config } from "../config";
import type { ArtifactStore } from "../artifacts/store";

export interface ArtifactResponse {
  status: number;
  headers: Record<string, string>;
  bodyBytes?: Buffer;
  bodyText?: string;
}

export interface HandleArtifactArgs {
  id: string;
  headers: Record<string, string | undefined>;
  cfg: Config;
  publicKey: KeyObject;
  store: ArtifactStore;
}

function unauthorized(cfg: Config): ArtifactResponse {
  return {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer realm="OpenBrowse MCP", resource="${cfg.resource}", resource_metadata="${cfg.issuer}/.well-known/oauth-protected-resource"`,
      "Content-Type": "application/json",
    },
    bodyText: JSON.stringify({ error: "unauthorized" }),
  };
}

function notFound(): ArtifactResponse {
  return {
    status: 404,
    headers: { "Content-Type": "application/json" },
    bodyText: JSON.stringify({ error: "not_found" }),
  };
}

export async function handleArtifact(
  args: HandleArtifactArgs,
): Promise<ArtifactResponse> {
  const { id, headers, cfg, publicKey, store } = args;
  const authHeader = headers.authorization ?? headers.Authorization;
  if (!authHeader) return unauthorized(cfg);
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return unauthorized(cfg);

  const verification = verifyJwt(match[1], publicKey, { audience: cfg.resource });
  if (!verification.valid) return unauthorized(cfg);

  const entry = store.get(id);
  // Per-client isolation: only the issuing client can fetch its artifacts.
  // We return 404 (not 403) when the entry exists but belongs to a different
  // client, to prevent id-enumeration probes.
  if (!entry || entry.ownerClientId !== verification.payload.sub) {
    return notFound();
  }

  const responseHeaders: Record<string, string> = {
    "content-type": entry.contentType,
    "cache-control": "private, max-age=300",
  };
  if (entry.filename) {
    // Strip ASCII control chars (CR/LF/NUL/etc.), quotes, and backslashes
    // from the filename to keep the Content-Disposition header well-formed
    // and prevent header injection.
    const safe = entry.filename.replace(/[\x00-\x1f"\\]/g, "");
    responseHeaders["content-disposition"] = `inline; filename="${safe}"`;
  }
  return {
    status: 200,
    headers: responseHeaders,
    bodyBytes: entry.bytes,
  };
}
