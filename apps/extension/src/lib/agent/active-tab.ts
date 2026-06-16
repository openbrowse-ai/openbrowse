import { tabRegistry, type LogicalTabId } from "./tab-registry";

/**
 * The agent's pinned target ltid. Resolved to a live `chrome.tabs.id` via
 * `tab-registry` immediately before any chrome.tabs / debugger call.
 *
 * Keying on ltid (not ctid) makes the target survive `chrome.tabs
 * .onReplaced` (Speculation Rules / prerender activation): the registry
 * re-keys the ltid → newCtid mapping atomically, so the next
 * `getActiveUserTab()` resolves to the new ctid without any code here
 * needing to react.
 */
let targetLtid: LogicalTabId | null = null;

/**
 * Get the current target chrome tab id. Compatibility shim for the
 * extension-driver / tools that still want a ctid; resolves the pinned
 * ltid through the registry. Returns null if no target is set or the
 * pinned ltid no longer resolves to a live tab.
 */
export function getTargetTabId(): number | null {
  if (targetLtid == null) return null;
  return tabRegistry.toChromeTabId(targetLtid) ?? null;
}

/** Get the current target LogicalTabId (or null when unset). */
export function getTargetLtid(): LogicalTabId | null {
  return targetLtid;
}

/**
 * Set a specific tab as the target for tool operations. Takes a chrome
 * tab id for caller convenience; minted/recovered to an ltid via the
 * registry so subsequent operations key on the stable identifier.
 *
 * Pass `null` to clear.
 */
export function setTargetTabId(tabId: number | null) {
  if (tabId == null) {
    targetLtid = null;
    return;
  }
  targetLtid = tabRegistry.registerExisting(tabId);
}

/** Set a specific LogicalTabId as the target. Used by callers that
 *  already have an ltid (e.g. handle-resolver paths). */
export function setTargetLtid(ltid: LogicalTabId | null) {
  targetLtid = ltid;
}

/**
 * Returns true if a URL is a non-inspectable Chrome internal or extension page.
 * Tool execution must NEVER route to these targets — this is exactly how the
 * home.html pinned-view routing bug happened (executeOnPage hit the extension
 * chat page instead of the agent's work tab).
 */
function isInternalChromeUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("devtools://")
  );
}

/**
 * Get the tab the agent should operate on.
 *
 * Resolution order:
 *  1. Explicit tracked target (the pinned ltid, resolved through the
 *     registry).
 *  2. First-call bootstrap: the user's active tab in the current window,
 *     but ONLY if it's a real web page (not an extension page or chrome://).
 *     The bootstrap result is registered with the registry to mint an
 *     ltid that's then pinned.
 *
 * We never fall back to `{active: true}` once a target exists — that was the
 * root cause of tool calls executing against the user's pinned home.html view
 * instead of the agent's tracked tab.
 */
export async function getActiveUserTab(): Promise<chrome.tabs.Tab> {
  if (targetLtid !== null) {
    const ctid = tabRegistry.toChromeTabId(targetLtid);
    if (ctid != null) {
      try {
        const tab = await chrome.tabs.get(ctid);
        if (tab) return tab;
      } catch {
        // Tracked tab no longer exists; clear and fall through to bootstrap.
        targetLtid = null;
      }
    } else {
      // Registry can't resolve the pinned ltid (e.g. SW restart hasn't
      // re-registered it yet). Clear and bootstrap.
      targetLtid = null;
    }
  }

  // Bootstrap: only on first tool call. Reject extension/chrome pages so the
  // agent never pins its target to its own UI.
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  for (const tab of tabs) {
    if (tab.id && !isInternalChromeUrl(tab.url)) {
      targetLtid = tabRegistry.registerExisting(tab.id);
      return tab;
    }
  }

  throw new Error(
    "No agent target tab. Call navigate(url) to open a work tab, or selectTab to choose one.",
  );
}

/**
 * Wait for a logical tab to finish loading after a navigation was
 * triggered. Resolves on the first `complete` event for whatever
 * `chrome.tabs.id` the ltid currently maps to — including across an
 * `onReplaced` mid-wait (the registry's `onReplace` event re-targets
 * which ctid the listener watches for).
 *
 * The `tabId` parameter is named that way for backward-compat with the
 * many call sites, but it's a LogicalTabId post-migration. The legacy
 * ctid-number signature is gone; if you need to wait on a raw ctid, mint
 * an ltid via `tabRegistry.registerExisting(ctid)` first.
 */
export function waitForTabLoad(
  ltid: LogicalTabId,
  timeoutMs = 15000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let currentCtid = tabRegistry.toChromeTabId(ltid) ?? null;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Tab load timed out"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      offReplace();
    }

    function listener(
      updatedTabId: number,
      changeInfo: { status?: string },
    ) {
      if (currentCtid != null && updatedTabId === currentCtid && changeInfo.status === "complete") {
        cleanup();
        // Tiny settle delay matches the legacy 500ms tail; gives Chrome
        // a chance to flush layout before tools run.
        setTimeout(resolve, 500);
      }
    }

    // If onReplaced fires mid-wait, switch the ctid we're watching for so
    // the resolver doesn't hang forever on the dead old id.
    const offReplace = tabRegistry.onReplace((ev) => {
      if (ev.ltid === ltid) {
        currentCtid = ev.newCtid;
      }
    });

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Programmatically inject the content script into a tab.
 * Used as a fallback when the declarative content script isn't present
 * (e.g. tab created in background, extension reloaded, etc.).
 */
async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-scripts/content.js"],
  });
  await new Promise((r) => setTimeout(r, 100));
}

/**
 * Send a message to the content script of a tab. If the content script
 * is not present, injects it programmatically and retries.
 */
export async function sendToContentScript<T = Record<string, unknown>>(
  tabId: number,
  message: Record<string, unknown>,
  maxRetries = 3,
  delayMs = 600,
): Promise<T> {
  let lastError: Error | null = null;
  let injected = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, message);
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!injected) {
        try {
          await injectContentScript(tabId);
          injected = true;
          continue;
        } catch {
          // injection failed (e.g. chrome:// page), fall through to retry
        }
      }

      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw lastError ?? new Error("Failed to communicate with content script");
}
