# @openbrowse/mcp-server

## 0.2.3

### Patch Changes

- 4fb8763: **Fix MCP bridge trust-prompt flicker loop and stale-session reconnect wedge.**

  Two related reliability fixes in the extension↔broker WebSocket handshake:

  - **`hello-defer` stops the trust-prompt flicker.** The broker armed a fixed 5s `hello-timeout` after sending `hello-challenge`, but first-run TOFU (and key-rotation) require a _human_ to approve the broker's identity in the extension UI — which can't happen in 5s. The broker would close the socket, the extension would reconnect and re-prompt, and the "verify this MCP helper" dialog flickered on/off every few seconds, making pairing nearly impossible. The extension now sends a `hello-defer` message the moment it needs a human decision; the broker cancels the short timeout and holds the socket open under a generous trust-decision window instead. The fast-fail path is preserved for genuinely dead/hung connections (the common already-trusted case still answers in milliseconds).

  - **Pong-based liveness eviction unwedges reconnects.** The broker enforces a single active session and rejects a second connection with `session_already_active`. If the paired extension's socket died _uncleanly_ (MV3 service-worker suspend, sleep/wake, network blip — no TCP FIN), the broker kept the session registered and rejected every reconnect until the OS TCP stack timed the dead socket out (minutes), leaving the panel stuck on "Not connected." The broker now pings each established session and terminates a socket that misses a pong, so a dead session self-clears within ~1–2 heartbeat intervals and the extension can re-pair. The heartbeat interval is configurable via `heartbeatIntervalMs` (default 20s).

  Tests: broker WS suite covers the deferred-then-completed handshake and dead-peer eviction; the extension connect suite covers sending `hello-defer` on both the TOFU and key-mismatch paths.

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
