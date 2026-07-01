import type { KeyObject } from "node:crypto";
import type { CodeStore } from "../oauth/codes";
import type { ClientRegistry } from "../oauth/clients";
import type { RefreshTokenStore } from "../oauth/refresh-tokens";
import { verifyPkce } from "../oauth/pkce";
import { mintJwt, type JwtClaims } from "../oauth/jwt";
import type { Config } from "../config";

export interface TokenResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface HandleTokenArgs {
  body: URLSearchParams;
  codes: CodeStore;
  clients: ClientRegistry;
  refreshTokens: RefreshTokenStore;
  privateKey: KeyObject;
  kid: string;
  cfg: Config;
}

const ACCESS_TOKEN_TTL_SECONDS = 3600;

export function handleToken({
  body,
  codes,
  clients,
  refreshTokens,
  privateKey,
  kid,
  cfg,
}: HandleTokenArgs): TokenResponse {
  const grant_type = body.get("grant_type") ?? "";

  if (grant_type === "authorization_code") {
    const code = body.get("code") ?? "";
    const redirect_uri = body.get("redirect_uri") ?? "";
    const client_id = body.get("client_id") ?? "";
    const code_verifier = body.get("code_verifier") ?? "";

    const redeem = codes.redeem(code, { client_id, redirect_uri });
    if (!redeem.ok) {
      return {
        status: 400,
        body: { error: "invalid_grant", error_description: redeem.reason },
      };
    }

    if (!verifyPkce(code_verifier, redeem.entry.code_challenge, redeem.entry.code_challenge_method)) {
      return {
        status: 400,
        body: { error: "invalid_grant", error_description: "PKCE verification failed" },
      };
    }

    const client = clients.get(client_id);
    const now = Math.floor(Date.now() / 1000);
    const claims: JwtClaims = {
      iss: cfg.issuer,
      aud: cfg.resource,
      sub: client_id,
      client_id,
      client_name: client?.client_name,
      scope: redeem.entry.scope,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
    };

    const refresh_token = refreshTokens.issue({
      clientId: client_id,
      scope: redeem.entry.scope,
    });

    return {
      status: 200,
      body: {
        access_token: mintJwt(privateKey, kid, claims),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token,
        scope: redeem.entry.scope,
      },
    };
  }

  if (grant_type === "refresh_token") {
    const refresh_token = body.get("refresh_token") ?? "";
    const r = refreshTokens.redeem(refresh_token);
    if (!r.ok) {
      return {
        status: 400,
        body: { error: "invalid_grant", error_description: r.reason },
      };
    }
    const client = clients.get(r.entry.clientId);
    const now = Math.floor(Date.now() / 1000);
    const claims: JwtClaims = {
      iss: cfg.issuer,
      aud: cfg.resource,
      sub: r.entry.clientId,
      client_id: r.entry.clientId,
      client_name: client?.client_name,
      scope: r.entry.scope,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
    };
    return {
      status: 200,
      body: {
        access_token: mintJwt(privateKey, kid, claims),
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: r.newToken,
        scope: r.entry.scope,
      },
    };
  }

  return {
    status: 400,
    body: { error: "unsupported_grant_type", error_description: `grant_type=${grant_type}` },
  };
}
