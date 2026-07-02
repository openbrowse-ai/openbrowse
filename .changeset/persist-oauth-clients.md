---
"@openbrowse/mcp-server": patch
---

Persist OAuth Dynamic Client Registration (DCR) records to
`~/.openbrowse/clients.json` so registered clients survive broker restarts.
Previously the client registry was in-memory only; any broker restart wiped
all registered clients, so MCP hosts that cached their `client_id` hit
`Unknown client_id` errors in the consent tab on their next authorization
attempt.

Registered clients are capped at 500 with least-recently-used eviction
(`last_used_at` refreshed on each successful authorization), and a corrupt
or unrecognized `clients.json` falls back to an empty registry instead of
crashing the broker.

Also improves recovery when an unknown `client_id` does reach `/authorize`:
loopback (`http://127.0.0.1` / `localhost`) redirect URIs now receive a
spec-compliant `302` with `error=invalid_client` so native MCP hosts can
auto-recover by re-registering, and all other cases get a human-readable
recovery page instead of a bare error string.
