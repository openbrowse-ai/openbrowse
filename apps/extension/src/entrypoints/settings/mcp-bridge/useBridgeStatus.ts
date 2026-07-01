import { useEffect, useState } from "react";
import type { BridgeStatus } from "@/entrypoints/background/mcp-bridge/status";
import {
  STATUS_PORT_NAME,
  type StatusTickMessage,
} from "@/entrypoints/background/mcp-bridge-status-port";

/**
 * Subscribe to bridge status changes pushed from the service worker
 * over a long-lived `chrome.runtime.connect` port.
 *
 * The hook returns the most recent status. On mount it opens the port;
 * the SW immediately replies with a snapshot of the current status,
 * then pushes on every transition. On unmount we disconnect, which
 * unsubscribes the SW emitter (preventing subscriber-set leaks
 * across page reloads).
 *
 * The default initial state is `disconnected` — chosen so the panel
 * renders a sensible placeholder for the ~1ms before the port opens
 * and the SW sends its first tick.
 */
export function useBridgeStatus(): BridgeStatus {
  const [status, setStatus] = useState<BridgeStatus>({ kind: "disconnected" });
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    try {
      port = chrome.runtime.connect({ name: STATUS_PORT_NAME });
    } catch {
      // `chrome.runtime.connect` can throw if the extension context
      // is invalidated (e.g. during an extension update). Fall back
      // to the default `disconnected` state; the user will see the
      // "Reconnect now" affordance and the page can be refreshed.
      return;
    }
    const handler = (raw: unknown) => {
      if (!isStatusTick(raw)) return;
      setStatus(raw.status);
    };
    port.onMessage.addListener(handler);
    return () => {
      try {
        port?.disconnect();
      } catch {
        // Already disconnected — fine.
      }
    };
  }, []);
  return status;
}

function isStatusTick(x: unknown): x is StatusTickMessage {
  return (
    x !== null &&
    typeof x === "object" &&
    (x as { type?: string }).type === "MCP_BRIDGE_STATUS_TICK" &&
    typeof (x as { status?: unknown }).status === "object"
  );
}
