import type { Config } from "../config";
import { SCOPES } from "../config";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: readonly string[];
  bearer_methods_supported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: readonly string[];
}

export function wellKnownProtectedResource(cfg: Config): ProtectedResourceMetadata {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
  };
}

export function wellKnownAuthorizationServer(cfg: Config): AuthorizationServerMetadata {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/authorize`,
    token_endpoint: `${cfg.issuer}/token`,
    registration_endpoint: `${cfg.issuer}/register`,
    jwks_uri: `${cfg.issuer}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES,
  };
}
