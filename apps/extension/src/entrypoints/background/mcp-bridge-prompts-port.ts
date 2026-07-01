/**
 * Service-worker side of the bridge pending-prompts push channel.
 *
 * The Settings → MCP Server → Activity surface opens a long-lived
 * `chrome.runtime.connect` port named `mcp-bridge:prompts`. On
 * connect we send a snapshot of the currently pending prompts; on
 * every add / remove / decision we push an updated snapshot.
 *
 * Lifecycle: per-port subscription via `onPromptsChange`. Disconnect
 * tears down the subscription so the emitter doesn't leak.
 *
 * The pattern is identical to `mcp-bridge-status-port.ts`; both ports
 * may be open concurrently from the same UI.
 */

import {
  listPendingPrompts,
  onPromptsChange,
  type PendingPrompt,
} from "./mcp-bridge/confirmation";

export const PROMPTS_PORT_NAME = "mcp-bridge:prompts";

export interface PromptsTickMessage {
  type: "MCP_BRIDGE_PROMPTS_TICK";
  prompts: PendingPrompt[];
}

/**
 * Register the `onConnect` listener for the prompts port. Invoke
 * once per SW lifetime from `background/index.ts`.
 */
export function attachPromptsPort(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PROMPTS_PORT_NAME) return;

    try {
      port.postMessage(makeTick(listPendingPrompts()));
    } catch {
      // Port disconnected before our first send. The onDisconnect
      // listener would still fire and run an empty unsubscribe; bail
      // early to avoid the redundant subscription.
      return;
    }

    const unsubscribe = onPromptsChange((prompts) => {
      try {
        port.postMessage(makeTick(prompts));
      } catch {
        // Port has died (page nav, refresh). `onDisconnect` will run
        // our cleanup; swallow here so the emitter doesn't see it.
      }
    });

    port.onDisconnect.addListener(() => {
      unsubscribe();
    });
  });
}

function makeTick(prompts: PendingPrompt[]): PromptsTickMessage {
  return { type: "MCP_BRIDGE_PROMPTS_TICK", prompts };
}
