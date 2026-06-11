/**
 * Single source of truth for the "OpenBrowse is working on this tab" overlay
 * (animated glow border + input-blocking shield + pill).
 *
 * Both the main agent (via agent-transport's tool wrapper) and the CUA
 * subagent (cua-loop) drive the overlay through `notifyAgentStatus`, so the
 * overlay's tab resolution, move/clear bookkeeping, color tint, and robust
 * (self-injecting) delivery live in exactly one place. This module is kept
 * dependency-light (only `./active-tab`) so callers on either side of the
 * agent-transport ↔ cua import boundary can use it without creating a cycle.
 */
import { getTargetTabId, sendToContentScript } from "./active-tab";

/** The space color used to tint the overlay glow. Set by the chat hook via
 *  agent-transport's `setAgentSpaceColor`; read here as the default tint. */
let currentSpaceColor: string | null = null;

export function setAgentSpaceColor(color: string | null) {
  currentSpaceColor = color;
}

export function getAgentSpaceColor(): string | null {
  return currentSpaceColor;
}

let indicatorQueue: Promise<void> = Promise.resolve();
/**
 * The tab the blocking indicator was last injected onto, so an idle
 * notification (which may not carry a tabId) can remove it from the
 * correct tab rather than the user's currently-focused one.
 */
let lastIndicatorTabId: number | null = null;

/**
 * Show or hide the blocking "working" overlay on the agent's work tab.
 *
 * Tab resolution mirrors the executor's own truth: callers pass the tabId the
 * tool actually operates on when they have it; otherwise we fall back to the
 * tracked target tab (`getTargetTabId`) — the same source `getActiveUserTab`
 * pins. The overlay must land on the worked tab, NOT whatever tab the user is
 * currently focused on (which may be a different, non-worked tab in the same
 * window when the agent works inside its owned tab group).
 *
 * Delivery uses `sendToContentScript`, which injects the content script and
 * retries if it isn't already present (e.g. a tab the agent opened in the
 * background, or after an extension reload).
 *
 * @param working  true to show, false to hide.
 * @param color    glow tint; defaults to the active space color.
 * @param tabId    the worked tab; when omitted/null, falls back to the tracked
 *                 target tab.
 */
export function notifyAgentStatus(
  working: boolean,
  color?: string | null,
  tabId?: number | null,
) {
  const tint = color === undefined ? currentSpaceColor : color;
  indicatorQueue = indicatorQueue.then(async () => {
    try {
      // When working, target the tool's tab if known, else the tracked
      // target. When idle, remove from whatever tab we last injected onto.
      const targetTabId = working
        ? (tabId ?? getTargetTabId() ?? lastIndicatorTabId)
        : (tabId ?? lastIndicatorTabId);
      if (targetTabId == null) {
        if (!working) lastIndicatorTabId = null;
        return;
      }
      let url = "";
      try {
        const tab = await chrome.tabs.get(targetTabId);
        url = tab.url ?? "";
      } catch {
        // Tab gone; nothing to inject/remove.
        if (!working) lastIndicatorTabId = null;
        return;
      }
      // Skip injection on internal pages (extension/chrome/devtools UI).
      if (
        url.startsWith("chrome://") ||
        url.startsWith("chrome-extension://") ||
        url.startsWith("devtools://")
      ) {
        return;
      }
      if (working) {
        // If the agent moved to a different tab within the same run,
        // clear the blocker from the previously-targeted tab so it
        // doesn't linger as a stale overlay.
        if (lastIndicatorTabId != null && lastIndicatorTabId !== targetTabId) {
          await sendToContentScript(lastIndicatorTabId, {
            type: "CHAT_CUA_WORKING_STATE",
            active: false,
          }).catch(() => {});
        }
        lastIndicatorTabId = targetTabId;
        await sendToContentScript(targetTabId, {
          type: "CHAT_CUA_WORKING_STATE",
          active: true,
          color: tint,
        }).catch(() => {});
      } else {
        lastIndicatorTabId = null;
        await sendToContentScript(targetTabId, {
          type: "CHAT_CUA_WORKING_STATE",
          active: false,
        }).catch(() => {});
      }
      chrome.runtime
        .sendMessage({
          type: working ? "AGENT_TAB_WORKING" : "AGENT_TAB_IDLE",
          tabId: targetTabId,
          color: tint,
        })
        .catch(() => {});
    } catch {
      // no resolvable tab
    }
  });
}
