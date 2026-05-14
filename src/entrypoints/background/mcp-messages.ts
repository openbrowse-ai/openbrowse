import { backgroundMcpRegistry } from "./mcp-registry";
import type { McpMessage } from "@/lib/mcp/messages";

export function handleMcpMessage(
  message: McpMessage,
  sendResponse: (response: unknown) => void,
): boolean {
  console.log("[MCP handler] Received:", message.type);
  switch (message.type) {
    case "MCP_CONNECT_ALL":
      backgroundMcpRegistry.connectAll(message.configs).then(() => {
        sendResponse({ ok: true, states: backgroundMcpRegistry.getStates() });
      });
      return true;

    case "MCP_CONNECT_SERVER":
      backgroundMcpRegistry.connectServer(message.config).then(() => {
        sendResponse({ ok: true, states: backgroundMcpRegistry.getStates() });
      });
      return true;

    case "MCP_DISCONNECT_SERVER":
      backgroundMcpRegistry.disconnectServer(message.serverId).then(() => {
        sendResponse({ ok: true, states: backgroundMcpRegistry.getStates() });
      });
      return true;

    case "MCP_DISCONNECT_ALL":
      backgroundMcpRegistry.disconnectAll().then(() => {
        sendResponse({ ok: true, states: backgroundMcpRegistry.getStates() });
      });
      return true;

    case "MCP_GET_STATES":
      sendResponse({ ok: true, states: backgroundMcpRegistry.getStates() });
      return true;

    case "MCP_GET_TOOLS":
      sendResponse({ ok: true, tools: backgroundMcpRegistry.getAllTools() });
      return true;

    case "MCP_CALL_TOOL":
      backgroundMcpRegistry.callTool(message.serverId, message.toolName, message.args).then(
        (result) => sendResponse({ ok: true, result }),
        (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return true;

    case "MCP_READ_RESOURCE":
      backgroundMcpRegistry.readResource(message.serverId, message.uri).then(
        (result) => sendResponse({ ok: true, result }),
        (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return true;

    case "MCP_GET_PROMPT":
      backgroundMcpRegistry.getPrompt(message.serverId, message.promptName, message.args).then(
        (result) => sendResponse({ ok: true, result }),
        (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
      return true;

    case "MCP_OAUTH_START":
      handleOAuthStart(message.serverId, sendResponse, message.serverConfig).catch((err) => {
        console.error("[MCP OAuth] Unhandled error:", err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
      return true;

    default:
      return false;
  }
}

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata> {
  // Step 1: Hit MCP server to get WWW-Authenticate header with resource_metadata URL
  const mcpRes = await fetch(serverUrl, { method: "GET", headers: { Accept: "application/json" } }).catch(() => null);
  const wwwAuth = mcpRes?.headers.get("www-authenticate") ?? "";
  const resourceMetadataMatch = wwwAuth.match(/resource_metadata="([^"]+)"/);

  if (resourceMetadataMatch) {
    // Step 2: Fetch protected resource metadata (RFC 9728)
    const resourceMetadataUrl = resourceMetadataMatch[1];
    const resourceRes = await fetch(resourceMetadataUrl).catch(() => null);
    if (resourceRes?.ok) {
      const resourceData = await resourceRes.json();
      const authServer = resourceData.authorization_servers?.[0];

      if (authServer) {
        // Step 3: Fetch authorization server metadata (RFC 8414)
        const asMetadataUrl = `${authServer}/.well-known/oauth-authorization-server`;
        const asRes = await fetch(asMetadataUrl).catch(() => null);
        if (asRes?.ok) {
          const asData = await asRes.json();
          return {
            authorization_endpoint: asData.authorization_endpoint,
            token_endpoint: asData.token_endpoint,
            registration_endpoint: asData.registration_endpoint,
            scopes_supported: resourceData.scopes_supported ?? asData.scopes_supported,
          };
        }
      }
    }
  }

  // Fallback: try well-known at origin and path-aware
  const url = new URL(serverUrl);
  const pathSegment = url.pathname.replace(/\/$/, "");
  if (pathSegment && pathSegment !== "/") {
    const pathAwareUrl = `${url.origin}/.well-known/oauth-authorization-server${pathSegment}`;
    const pathRes = await fetch(pathAwareUrl).catch(() => null);
    if (pathRes?.ok) return pathRes.json();
  }

  const wellKnownUrl = `${url.origin}/.well-known/oauth-authorization-server`;
  const res = await fetch(wellKnownUrl).catch(() => null);
  if (res?.ok) return res.json();

  // Last resort: default paths relative to MCP server URL
  const base = serverUrl.replace(/\/+$/, "");
  return {
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
  };
}

async function dynamicClientRegistration(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ client_id: string; client_secret?: string }> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "OpenBrowse",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!res.ok) {
    throw new Error(`Dynamic client registration failed: ${res.status}`);
  }

  const data = await res.json();
  return { client_id: data.client_id, client_secret: data.client_secret };
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// Store PKCE verifiers in memory (keyed by serverId)
const pkceVerifiers = new Map<string, string>();

async function handleOAuthStart(serverId: string, sendResponse: (r: unknown) => void, passedConfig?: import("@/lib/mcp/types").McpServerConfig) {
  try {
    console.log("[MCP OAuth] Starting for serverId:", serverId);
    const { storage } = await import("@/lib/storage");
    const settings = await storage.getSettings();
    const serverConfig = passedConfig ?? settings.mcpServers.find((s) => s.id === serverId);
    if (!serverConfig) {
      console.log("[MCP OAuth] Server not found in settings. Available:", settings.mcpServers.map(s => s.id));
      sendResponse({ ok: false, error: "Server not found" });
      return;
    }

    // Discover OAuth metadata from server
    console.log("[MCP OAuth] Discovering metadata for:", serverConfig.url);
    const metadata = await discoverOAuthMetadata(serverConfig.url);
    console.log("[MCP OAuth] Metadata:", metadata);
    const redirectUri = chrome.identity.getRedirectURL();
    console.log("[MCP OAuth] Redirect URI:", redirectUri);

    // Dynamic client registration (RFC 7591) if available and no client_id stored
    let clientId = serverConfig.auth?.clientId;
    let clientSecret = serverConfig.auth?.clientSecret;

    if (!clientId && metadata.registration_endpoint) {
      const registration = await dynamicClientRegistration(
        metadata.registration_endpoint,
        redirectUri,
      );
      clientId = registration.client_id;
      clientSecret = registration.client_secret;

      // Persist the client_id for future use
      const updatedServers = settings.mcpServers.map((s) =>
        s.id === serverId
          ? { ...s, auth: { ...s.auth, type: "oauth" as const, clientId, clientSecret } }
          : s,
      );
      await storage.setSettings({ ...settings, mcpServers: updatedServers });
    }

    if (!clientId) {
      const error = metadata.registration_endpoint
        ? "Dynamic client registration failed and no client_id is configured."
        : `${serverConfig.name || "This server"} does not support dynamic client registration. Provide a client_id (and client_secret if required) in the connector's auth settings.`;
      console.error("[MCP OAuth] Aborting:", error, {
        serverId,
        serverUrl: serverConfig.url,
        hasRegistrationEndpoint: Boolean(metadata.registration_endpoint),
      });
      sendResponse({ ok: false, error });
      return;
    }

    // Generate PKCE code verifier and challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    pkceVerifiers.set(serverId, codeVerifier);

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

    if (metadata.scopes_supported?.length) {
      params.set("scope", metadata.scopes_supported.join(" "));
    }

    const authUrl = `${metadata.authorization_endpoint}?${params.toString()}`;

    // Launch browser auth flow
    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });

    if (!responseUrl) {
      pkceVerifiers.delete(serverId);
      sendResponse({ ok: false, error: "Auth flow cancelled" });
      return;
    }

    const code = new URL(responseUrl).searchParams.get("code");
    if (!code) {
      pkceVerifiers.delete(serverId);
      sendResponse({ ok: false, error: "No authorization code in response" });
      return;
    }

    // Exchange code for token
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });

    const tokenRes = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });

    pkceVerifiers.delete(serverId);

    if (!tokenRes.ok) {
      sendResponse({ ok: false, error: `Token exchange failed: ${tokenRes.status}` });
      return;
    }

    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    // Store token and reconnect
    const currentSettings = await storage.getSettings();
    const updatedServers = currentSettings.mcpServers.map((s) =>
      s.id === serverId
        ? { ...s, auth: { ...s.auth, type: "oauth" as const, token, clientId, clientSecret } }
        : s,
    );
    await storage.setSettings({ ...currentSettings, mcpServers: updatedServers });

    const updatedConfig = updatedServers.find((s) => s.id === serverId)!;
    await backgroundMcpRegistry.connectServer(updatedConfig);

    sendResponse({ ok: true, states: backgroundMcpRegistry.getStates() });
  } catch (err) {
    sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
