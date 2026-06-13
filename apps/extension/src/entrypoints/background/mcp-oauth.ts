import { storage } from "@/lib/storage";
import type { McpAuthConfig } from "@/lib/mcp/types";

/**
 * Shared OAuth token-lifecycle helpers for MCP connectors.
 *
 * Lives in its own module (imported by both `mcp-registry` and
 * `mcp-messages`) to avoid a circular import: `mcp-messages` already imports
 * `mcp-registry`, so the registry can't import refresh logic back from
 * `mcp-messages` without a cycle.
 *
 * Why this exists: connector access tokens are stored durably in
 * `chrome.storage.local`, but they expire. On a service-worker restart
 * (notably an extension update) the registry reconnects by replaying the
 * stored token; if it has expired the server returns 401 and the connector
 * would otherwise be stuck at `auth_required`, forcing a full re-auth. With a
 * stored refresh token we instead mint a fresh access token silently.
 */

const DEFAULT_EXPIRY_SKEW_MS = 60_000;

/**
 * Decide the OAuth `scope` to request at authorization time.
 *
 * We want `offline_access` whenever possible — that RFC scope is what makes
 * many providers issue a refresh_token (so we can silently refresh after a
 * service-worker restart / extension update) — but strict providers reject
 * unknown scopes, so it can't be added blindly. Two safe cases add it:
 *   1. The provider lists `offline_access` in `scopes_supported` (e.g. Attio).
 *   2. The provider publishes NO `scopes_supported` at all but DOES advertise
 *      the `refresh_token` grant (e.g. Stripe). With no declared scope set
 *      there's nothing to reject against, and the provider still needs a
 *      signal that we want offline access.
 *
 * Returns the space-joined scope string, or `undefined` when there is nothing
 * to request (so the caller omits the `scope` param entirely).
 */
export function buildAuthScope(metadata: {
  scopes_supported?: string[];
  grant_types_supported?: string[];
}): string | undefined {
  const supportedScopes = metadata.scopes_supported ?? [];
  const grantTypes = metadata.grant_types_supported ?? [];
  const supportsRefreshGrant = grantTypes.includes("refresh_token");
  const scopeSet = new Set<string>(supportedScopes);
  if (supportedScopes.includes("offline_access")) {
    scopeSet.add("offline_access");
  } else if (supportedScopes.length === 0 && supportsRefreshGrant) {
    scopeSet.add("offline_access");
  }
  return scopeSet.size > 0 ? Array.from(scopeSet).join(" ") : undefined;
}

/**
 * True when `auth` carries an expiry that is at/after the skew window — i.e.
 * the access token is expired or about to expire and should be refreshed
 * before use. Returns false when no `expiresAt` is known (we can't tell, so
 * we let the connect attempt proceed and rely on reactive 401 refresh).
 */
export function tokenIsExpiring(
  auth: McpAuthConfig | undefined,
  skewMs: number = DEFAULT_EXPIRY_SKEW_MS,
): boolean {
  if (!auth?.expiresAt) return false;
  return Date.now() > auth.expiresAt - skewMs;
}

/** Persist a partial auth patch onto a server's stored config. */
export async function persistAuth(
  serverId: string,
  patch: Partial<McpAuthConfig>,
): Promise<void> {
  await storage.updateSettings((current) => {
    const mcpServers = current.mcpServers.map((s) =>
      s.id === serverId
        ? {
            ...s,
            auth: {
              type: "oauth" as const,
              ...s.auth,
              ...patch,
            },
          }
        : s,
    );
    return { ...current, mcpServers };
  });
}

/**
 * Normalize a raw OAuth token response into an auth patch. Captures the
 * refresh token, expiry, and scope that the previous implementation
 * discarded. `refresh_token` rotation is honored (some providers return a new
 * one on each refresh); when absent the existing one is preserved by the
 * caller via the spread in `persistAuth`.
 */
export function authPatchFromTokenResponse(
  tokenData: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  },
  extra: { tokenEndpoint?: string; scope?: string } = {},
): Partial<McpAuthConfig> {
  const patch: Partial<McpAuthConfig> = { type: "oauth" };
  if (typeof tokenData.access_token === "string") {
    patch.token = tokenData.access_token;
  }
  if (typeof tokenData.refresh_token === "string") {
    patch.refreshToken = tokenData.refresh_token;
  }
  if (typeof tokenData.expires_in === "number") {
    patch.expiresAt = Date.now() + tokenData.expires_in * 1000;
  }
  const scope = tokenData.scope ?? extra.scope;
  if (typeof scope === "string" && scope.length > 0) {
    patch.scope = scope;
  }
  if (extra.tokenEndpoint) {
    patch.tokenEndpoint = extra.tokenEndpoint;
  }
  return patch;
}

// Serialize refreshes per server so concurrent callers (startup connect +
// a racing tool call) don't stampede the token endpoint with the same
// refresh token (which some providers invalidate on first use).
const inFlightRefreshes = new Map<string, Promise<string | null>>();

/**
 * Exchange the stored refresh token for a fresh access token, persist it, and
 * return the new token. Returns `null` when refresh isn't possible (no refresh
 * token / token endpoint) or the server rejects the refresh — in which case
 * the caller should fall back to `auth_required` (genuine re-auth needed).
 */
export async function refreshAccessToken(
  serverId: string,
): Promise<string | null> {
  const existing = inFlightRefreshes.get(serverId);
  if (existing) return existing;

  const run = (async (): Promise<string | null> => {
    const settings = await storage.getSettings();
    const server = settings.mcpServers.find((s) => s.id === serverId);
    const auth = server?.auth;
    if (!auth?.refreshToken || !auth.tokenEndpoint) return null;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
    });
    if (auth.clientId) body.set("client_id", auth.clientId);
    if (auth.clientSecret) body.set("client_secret", auth.clientSecret);
    if (auth.scope) body.set("scope", auth.scope);

    let res: Response;
    try {
      res = await fetch(auth.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      return null;
    }
    if (!res.ok) return null;

    let tokenData: {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    try {
      tokenData = await res.json();
    } catch {
      return null;
    }
    if (typeof tokenData.access_token !== "string") return null;

    const patch = authPatchFromTokenResponse(tokenData, {
      tokenEndpoint: auth.tokenEndpoint,
      scope: auth.scope,
    });
    await persistAuth(serverId, patch);
    return tokenData.access_token;
  })();

  inFlightRefreshes.set(serverId, run);
  try {
    return await run;
  } finally {
    inFlightRefreshes.delete(serverId);
  }
}

/** True if an error looks like an HTTP 401 / Unauthorized. */
export function isUnauthorizedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("401") || message.includes("Unauthorized");
}
