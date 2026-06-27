import { backgroundMcpRegistry } from "./mcp-registry";
import { loadArtifact } from "@/lib/artifacts/registry";
import { checkAllowlist } from "@/lib/artifacts/rpc";
import { isHostAllowed } from "@/lib/artifacts/network-allowlist";
import { arrayBufferToBase64, base64ToArrayBuffer } from "@/lib/artifacts/base64";
import { getConnector } from "@openbrowse/connectors";
import { storage } from "@/lib/storage";
import type {
  HostToBackgroundMessage,
  BackgroundResponse,
} from "@/lib/artifacts/rpc";

/** Request/response body caps for brokered fetch. */
const MAX_REQUEST_BODY = 1 * 1024 * 1024; // 1 MB
const MAX_RESPONSE_BODY = 10 * 1024 * 1024; // 10 MB
/**
 * Request headers the artifact may not set — the platform controls cookies and
 * the standard browser-forbidden headers. `Authorization` is intentionally
 * allowed (API-key use cases).
 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "cookie",
  "host",
  "origin",
  "referer",
]);

/**
 * Resolve a manifest server token (the stable connector id, e.g. "linear")
 * to the live server config id in the user's settings.
 *
 * Artifacts reference MCP tools as `mcp.<connectorId>.<tool>` using the
 * stable connector definition id. But connected servers are stored with a
 * random per-install UUID id (ConnectorsTab assigns crypto.randomUUID() on
 * connect). We bridge the two by matching the connector definition's URL
 * against the stored server's URL.
 *
 * Returns the real server id, or null if no matching connected server is
 * configured. Falls back to treating the token itself as a server id (for
 * custom servers a user may have keyed directly).
 */
async function resolveServerId(token: string): Promise<string | null> {
  let servers: { id: string; url: string }[] = [];
  try {
    const settings = await storage.getSettings();
    servers = settings.mcpServers.map((s) => ({ id: s.id, url: s.url }));
  } catch {
    servers = [];
  }

  // Exact id match first (custom servers, or already-resolved ids).
  if (servers.some((s) => s.id === token)) return token;

  // Map the connector definition id → url → stored server id.
  const def = getConnector(token);
  if (def?.url) {
    const match = servers.find((s) => s.url === def.url);
    if (match) return match.id;
  }
  return null;
}

/**
 * Returns true if the message was handled (caller's onMessage listener
 * must `return true` to keep sendResponse alive).
 */
export function handleArtifactRpc(
  message: HostToBackgroundMessage,
  sendResponse: (response: BackgroundResponse) => void,
): boolean {
  switch (message.type) {
    case "ARTIFACT_RPC_CALL_MCP":
      handleCallMcp(message).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: errMsg(err) }),
      );
      return true;
    case "ARTIFACT_RPC_RUN_TOOL":
      handleRunTool(message).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: errMsg(err) }),
      );
      return true;
    case "ARTIFACT_RPC_NETWORK_FETCH":
      handleNetworkFetch(message).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: errMsg(err) }),
      );
      return true;
    default: {
      // TS will catch this if a new variant is added to HostToBackgroundMessage
      // and forgotten here — `_exhaustive` will be inferred as `never`.
      const _exhaustive: never = message;
      sendResponse({
        ok: false,
        error: `unknown ARTIFACT_RPC type: ${(message as { type?: string }).type}`,
      });
      void _exhaustive;
      return true;
    }
  }
}

async function handleCallMcp(
  m: Extract<HostToBackgroundMessage, { type: "ARTIFACT_RPC_CALL_MCP" }>,
): Promise<BackgroundResponse> {
  const art = await loadArtifact(m.artifactId);
  if (!art) return { ok: false, error: `unknown artifact: ${m.artifactId}` };
  // The MCP tool name in the manifest is "mcp.<server>.<tool>"; reconstruct
  // server + tool from the request.
  const declared = art.manifest.tools.find((t) => t.name === m.toolName);
  if (!declared || !m.toolName.startsWith("mcp.")) {
    return { ok: false, error: `tool '${m.toolName}' not declared / not an mcp tool` };
  }
  const allow = checkAllowlist(art.manifest, art.sidecar, m.toolName);
  if (!allow.ok) return { ok: false, error: allow.error };

  const parts = m.toolName.split(".");
  const serverToken = parts[1];
  const tool = parts.slice(2).join(".");
  try {
    // Manifests reference the stable connector id ("linear"); the live
    // registry is keyed by the per-install server UUID. Resolve it.
    const serverId = await resolveServerId(serverToken);
    if (!serverId) {
      return {
        ok: false,
        error: `MCP server '${serverToken}' is not connected. Open Settings → Connectors and connect it, then retry.`,
      };
    }
    // The MV3 service worker may have been respawned for this RPC with an
    // empty connection map (artifact tabs never call connectAll). Lazily
    // (re)connect from stored settings before dispatching.
    const connected = await backgroundMcpRegistry.ensureServerConnected(serverId);
    if (!connected) {
      return {
        ok: false,
        error: `MCP server '${serverToken}' is not connected. Open Settings → Connectors and connect it, then retry.`,
      };
    }
    const result = await backgroundMcpRegistry.callTool(serverId, tool, m.args);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

async function handleRunTool(
  m: Extract<HostToBackgroundMessage, { type: "ARTIFACT_RPC_RUN_TOOL" }>,
): Promise<BackgroundResponse> {
  const art = await loadArtifact(m.artifactId);
  if (!art) return { ok: false, error: `unknown artifact: ${m.artifactId}` };
  const declared = art.manifest.tools.find((t) => t.name === m.toolName);
  if (!declared || (!m.toolName.startsWith("browser.") && !m.toolName.startsWith("system."))) {
    return { ok: false, error: `tool '${m.toolName}' not declared / not a browser/system tool` };
  }
  const allow = checkAllowlist(art.manifest, art.sidecar, m.toolName);
  if (!allow.ok) return { ok: false, error: allow.error };
  // V1: only a small whitelist of browser tools is wired in. Expand later.
  return { ok: false, error: `runTool: '${m.toolName}' not yet supported in v1` };
}

async function handleNetworkFetch(
  m: Extract<HostToBackgroundMessage, { type: "ARTIFACT_RPC_NETWORK_FETCH" }>,
): Promise<BackgroundResponse> {
  const art = await loadArtifact(m.artifactId);
  if (!art) return { ok: false, error: `unknown artifact: ${m.artifactId}` };
  const allowlist = art.manifest.network ?? [];

  // Validate the initial URL (authoritative gate; the host pre-checks too).
  let url: URL;
  try {
    url = new URL(m.url);
  } catch {
    return { ok: false, error: `network.fetch: invalid URL '${m.url}'` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "network.fetch: only http(s) URLs are allowed" };
  }
  if (!isHostAllowed(url.host, allowlist)) {
    return { ok: false, error: `network.fetch: host '${url.host}' is not in the artifact's network allowlist` };
  }

  const init = m.init ?? {};

  // Reconstruct the request body. Text arrives as `body` (string); binary
  // arrives as `bodyB64` (base64) because a raw ArrayBuffer cannot survive the
  // JSON serialization of chrome.runtime.sendMessage.
  let reqBody: string | ArrayBuffer | undefined;
  if (typeof init.bodyB64 === "string") reqBody = base64ToArrayBuffer(init.bodyB64);
  else if (typeof init.body === "string") reqBody = init.body;

  // Body size cap (request).
  let bodyByteLength = 0;
  if (typeof reqBody === "string") bodyByteLength = new TextEncoder().encode(reqBody).length;
  else if (reqBody instanceof ArrayBuffer) bodyByteLength = reqBody.byteLength;
  if (bodyByteLength > MAX_REQUEST_BODY) {
    return { ok: false, error: `network.fetch: request body exceeds ${MAX_REQUEST_BODY} bytes` };
  }

  // Filter request headers against the forbidden list.
  const headers = new Headers();
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    if (FORBIDDEN_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }

  const method = (init.method ?? "GET").toUpperCase();
  const credentials = init.credentials ?? "omit";
  const body =
    method === "GET" || method === "HEAD" ? undefined : (reqBody ?? undefined);

  try {
    // Let the browser follow redirects, then re-validate where we actually
    // landed. Manual redirect-following is not viable here: from a service
    // worker, a cross-origin `redirect: "manual"` fetch returns an opaque
    // response (`type: "opaqueredirect"`, `status: 0`, unreadable `Location`),
    // so we could neither read the hop target nor hand the result back as a
    // real Response. With "follow", the browser caps the hop count itself; we
    // re-check the final host against the allowlist as the security gate.
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body as BodyInit | undefined,
      credentials,
      redirect: "follow",
    });

    // An opaque / opaqueredirect response exposes status 0 and an empty body —
    // reject rather than constructing an invalid Response on the caller side.
    if (response.type === "opaqueredirect" || response.type === "opaque") {
      return { ok: false, error: "network.fetch: blocked opaque redirect" };
    }
    if (response.status === 0) {
      return { ok: false, error: "network.fetch: request failed (status 0)" };
    }

    // Re-validate the final landing host: an allowed host must not be able to
    // redirect us off the allowlist.
    if (response.url) {
      let finalUrl: URL;
      try {
        finalUrl = new URL(response.url);
      } catch {
        return { ok: false, error: `network.fetch: invalid final URL '${response.url}'` };
      }
      if (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:") {
        return { ok: false, error: "network.fetch: redirected to non-http(s)" };
      }
      if (!isHostAllowed(finalUrl.host, allowlist)) {
        return { ok: false, error: `network.fetch: redirected to '${finalUrl.host}', which is not in the allowlist` };
      }
    }

    const buf = await response.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BODY) {
      return { ok: false, error: `network.fetch: response body exceeds ${MAX_RESPONSE_BODY} bytes` };
    }

    // Return headers minus Set-Cookie (no point handing cookies to the sandbox).
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      outHeaders[key] = value;
    });

    return {
      ok: true,
      result: {
        status: response.status,
        statusText: response.statusText,
        headers: outHeaders,
        // base64 so the bytes survive chrome.runtime.sendMessage's JSON
        // serialization (a raw ArrayBuffer would arrive as `{}`).
        bodyB64: arrayBufferToBase64(buf),
      },
    };
  } catch (e) {
    return { ok: false, error: `network.fetch: ${errMsg(e)}` };
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
