/**
 * Service-worker side of the bridge status push channel.
 *
 * The settings UI opens a long-lived `chrome.runtime.connect` port
 * named `mcp-bridge:status`. We send the current `BridgeStatus`
 * immediately on connect, then push every subsequent transition.
 *
 * Why a port (not polling): zero perceived latency on TOFU prompts,
 * and the MV3 service worker stays alive only while the port is
 * open — which matches "the user has the settings page open".
 *
 * Lifecycle: each connected port adds itself to a per-port unsubscribe
 * function created against the `onStatusChange` emitter. On
 * `onDisconnect` we run the unsubscribe so the emitter doesn't leak
 * subscribers across port churn (e.g. settings page reload).
 */

import { getStatus, onStatusChange } from "./mcp-bridge/boot";
import type { BridgeStatus } from "./mcp-bridge/status";

export const STATUS_PORT_NAME = "mcp-bridge:status";

export interface StatusTickMessage {
  type: "MCP_BRIDGE_STATUS_TICK";
  status: BridgeStatus;
}

/**
 * Register the `onConnect` listener for the status port.
 *
 * Safe to call from `background/index.ts` startup. Idempotent in the
 * sense that re-calling it just registers a second listener that does
 * the same thing — but to keep the SW free of duplicate listener
 * leaks, callers must ensure they invoke this exactly once per SW
 * lifetime.
 */
export function attachStatusPort(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== STATUS_PORT_NAME) return;

    // Snapshot first so the UI doesn't render a placeholder while
    // waiting for the next transition.
    try {
      port.postMessage(makeTick(getStatus()));
    } catch {
      // Port disconnected before our first send — nothing to clean
      // up yet.
      return;
    }

    const unsubscribe = onStatusChange((status) => {
      try {
        port.postMessage(makeTick(status));
      } catch {
        // Port has died (page nav, refresh). `onDisconnect` will
        // run our cleanup; here we just swallow the throw so the
        // emitter doesn't see it.
      }
    });

    port.onDisconnect.addListener(() => {
      unsubscribe();
    });
  });
}

function makeTick(status: BridgeStatus): StatusTickMessage {
  return { type: "MCP_BRIDGE_STATUS_TICK", status };
}
