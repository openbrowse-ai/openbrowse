import { useEffect, useState } from "react";
import {
  PROMPTS_PORT_NAME,
  type PromptsTickMessage,
} from "@/entrypoints/background/mcp-bridge-prompts-port";
import type { PendingPrompt } from "@/entrypoints/background/mcp-bridge/confirmation";

/**
 * Subscribe to pending MCP confirmation prompts pushed from the SW
 * over a long-lived `chrome.runtime.connect` port.
 *
 * Mirrors `useBridgeStatus` — same lifecycle, same defensive
 * try/catch around `chrome.runtime.connect`.
 */
export function usePendingPrompts(): PendingPrompt[] {
  const [prompts, setPrompts] = useState<PendingPrompt[]>([]);
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    try {
      port = chrome.runtime.connect({ name: PROMPTS_PORT_NAME });
    } catch {
      return;
    }
    const handler = (raw: unknown) => {
      if (!isTick(raw)) return;
      setPrompts(raw.prompts);
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
  return prompts;
}

function isTick(x: unknown): x is PromptsTickMessage {
  return (
    x !== null &&
    typeof x === "object" &&
    (x as { type?: string }).type === "MCP_BRIDGE_PROMPTS_TICK" &&
    Array.isArray((x as { prompts?: unknown }).prompts)
  );
}
