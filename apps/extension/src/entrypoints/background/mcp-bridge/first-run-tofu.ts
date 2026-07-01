/**
 * First-run auto-open of the MCP Bridge settings tab.
 *
 * On the very first transition into `awaiting_tofu` after the
 * extension is installed, open the settings page (scrolled to the MCP
 * Bridge section) in a new tab so the user discovers the pairing
 * affordance without having to know to look there.
 *
 * Suppressed forever after the first run. Subsequent TOFU prompts —
 * whether triggered by a key rotation or by the user manually clearing
 * trust — rely on the toolbar badge instead, so we don't tab-spam.
 *
 * Storage key: `mcpBridge.firstRunHandled` (boolean). The check is
 * read-modify-write but is intentionally NOT atomic — the worst-case
 * race here is "two SW boots both open a tab", which is harmless;
 * each `chrome.tabs.create` just yields one tab and the user closes
 * it. Skipping the lock keeps the code simple.
 */

import { onStatusChange } from "./boot";

const FLAG_KEY = "mcpBridge.firstRunHandled";
const SETTINGS_PATH = "settings.html";

/**
 * Subscribe the first-run handler to the bridge emitter. Returns an
 * unsubscribe fn for symmetry, though in practice it's never called —
 * the handler lives for the lifetime of the SW.
 */
export function attachFirstRunHandler(): () => void {
  return onStatusChange((status) => {
    if (status.kind !== "awaiting_tofu") return;
    void maybeOpenFirstRunTab();
  });
}

async function maybeOpenFirstRunTab(): Promise<void> {
  try {
    const obj = await chrome.storage.local.get(FLAG_KEY);
    if (obj[FLAG_KEY]) return;
    await chrome.storage.local.set({ [FLAG_KEY]: true });
    const url = chrome.runtime.getURL(SETTINGS_PATH) + "#mcp-bridge";
    await chrome.tabs.create({ url, active: true });
  } catch {
    // Storage or tabs unavailable — the badge still surfaces the
    // prompt, so silent failure is acceptable.
  }
}

/**
 * Reset the first-run flag. Test-only and emergency-only — there's no
 * UI affordance for this in normal operation. Exported so tests can
 * reset state between cases.
 */
export async function resetFirstRunFlag(): Promise<void> {
  try {
    await chrome.storage.local.remove(FLAG_KEY);
  } catch {
    // No-op.
  }
}
