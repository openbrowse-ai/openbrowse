---
"@openbrowse/mcp-server": patch
"openbrowse": patch
---

**Fix MCP bridge trust-prompt flicker loop and stale-session reconnect wedge.**

Two related reliability fixes in the extension↔broker WebSocket handshake:

- **`hello-defer` stops the trust-prompt flicker.** The broker armed a fixed 5s `hello-timeout` after sending `hello-challenge`, but first-run TOFU (and key-rotation) require a *human* to approve the broker's identity in the extension UI — which can't happen in 5s. The broker would close the socket, the extension would reconnect and re-prompt, and the "verify this MCP helper" dialog flickered on/off every few seconds, making pairing nearly impossible. The extension now sends a `hello-defer` message the moment it needs a human decision; the broker cancels the short timeout and holds the socket open under a generous trust-decision window instead. The fast-fail path is preserved for genuinely dead/hung connections (the common already-trusted case still answers in milliseconds).

- **Pong-based liveness eviction unwedges reconnects.** The broker enforces a single active session and rejects a second connection with `session_already_active`. If the paired extension's socket died *uncleanly* (MV3 service-worker suspend, sleep/wake, network blip — no TCP FIN), the broker kept the session registered and rejected every reconnect until the OS TCP stack timed the dead socket out (minutes), leaving the panel stuck on "Not connected." The broker now pings each established session and terminates a socket that misses a pong, so a dead session self-clears within ~1–2 heartbeat intervals and the extension can re-pair. The heartbeat interval is configurable via `heartbeatIntervalMs` (default 20s).

Tests: broker WS suite covers the deferred-then-completed handshake and dead-peer eviction; the extension connect suite covers sending `hello-defer` on both the TOFU and key-mismatch paths.
