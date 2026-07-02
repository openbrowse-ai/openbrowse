---
"openbrowse": patch
---

**Fix Notion connector "Failed to connect" by updating the hosted MCP URL to notion.com.**

The Notion connector definition pointed at `https://mcp.notion.so/mcp`, which no longer resolves — DNS lookups for `mcp.notion.so` fail outright. Notion moved its hosted MCP endpoint to `https://mcp.notion.com/mcp`.

Because the very first request in `discoverOAuthMetadata` (the `GET` against the MCP URL to read `WWW-Authenticate: resource_metadata=...`) never got a response, every downstream fallback path in `handleOAuthStart` also failed against the same dead host, and the entire flow rejected with a fetch error before `chrome.identity.launchWebAuthFlow` was ever reached. The user saw an immediate "Failed to connect Notion" toast the moment they clicked Connect.

Verified the corrected host end-to-end:

- `GET https://mcp.notion.com/mcp` → `401` with `WWW-Authenticate: Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", ...` — matches the RFC 9728 discovery path OpenBrowse already implements.
- The resource metadata declares `authorization_servers: ["https://mcp.notion.com"]`.
- `GET https://mcp.notion.com/.well-known/oauth-authorization-server` returns full RFC 8414 metadata: `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, PKCE (`S256`), and `grant_types_supported: ["authorization_code", "refresh_token"]` — so both the initial exchange and silent refresh-after-SW-restart paths are supported.

Fix: `packages/connectors/src/notion.ts` — change the `url` field from `https://mcp.notion.so/mcp` to `https://mcp.notion.com/mcp`. No other files reference the old host.
