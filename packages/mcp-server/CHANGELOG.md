# @openbrowse/mcp-server

## 0.2.2

### Patch Changes

- 829cecf: Fix recurring `extension_not_connected` errors caused by Chrome's MV3
  service worker idle timeout killing the WebSocket connection.

  The broker now sends a lightweight `ping` message every 20 seconds over
  the WS channel, resetting Chrome's idle timer and keeping the extension
  alive. The extension's `chrome.alarms` keepalive is relaxed to a 1-minute
  safety net (reconnects if the SW was killed for other reasons).

## 0.2.1

### Patch Changes

- 3c7abee: Persist OAuth Dynamic Client Registration (DCR) records to
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

## 0.2.0

### Minor Changes

- 77527af: Initial public release of the OpenBrowse MCP broker.

  The broker is a local OAuth 2.1 + WebSocket bridge that lets external
  MCP hosts (Cursor, Claude Desktop, OpenCode, Continue, etc.) drive the
  OpenBrowse browser extension. It ships as an npm package
  (`@openbrowse/mcp-server`, invoked as `openbrowse-mcp`) and a Homebrew
  formula (`openbrowse-ai/tap/openbrowse-mcp`).

  Full feature set was landed in PR #176 (feat(mcp): OpenBrowse MCP
  subagent bridge, Phases 1-4); this changeset publishes the artefact.
