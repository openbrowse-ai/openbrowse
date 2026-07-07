---
"@openbrowse/mcp-server": patch
"@openbrowse/extension": patch
---

Fix recurring `extension_not_connected` errors caused by Chrome's MV3
service worker idle timeout killing the WebSocket connection.

The broker now sends a lightweight `ping` message every 20 seconds over
the WS channel, resetting Chrome's idle timer and keeping the extension
alive. The extension's `chrome.alarms` keepalive is relaxed to a 1-minute
safety net (reconnects if the SW was killed for other reasons).
