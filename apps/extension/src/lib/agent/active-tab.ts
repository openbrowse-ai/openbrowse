let targetTabId: number | null = null;

/**
 * Get the current target tab ID (set via selectTab).
 */
export function getTargetTabId(): number | null {
  return targetTabId;
}

/**
 * Set a specific tab as the target for tool operations.
 */
export function setTargetTabId(tabId: number | null) {
  targetTabId = tabId;
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
 *  1. Explicit tracked target (set by navigate/selectTab).
 *  2. First-call bootstrap: the user's active tab in the current window,
 *     but ONLY if it's a real web page (not an extension page or chrome://).
 *     Once bootstrapped, the target is pinned and never silently replaced.
 *
 * We never fall back to `{active: true}` once a target exists — that was the
 * root cause of tool calls executing against the user's pinned home.html view
 * instead of the agent's tracked tab.
 */
export async function getActiveUserTab(): Promise<chrome.tabs.Tab> {
  if (targetTabId !== null) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      if (tab) return tab;
    } catch {
      // Tracked tab no longer exists; clear and fall through to bootstrap.
      targetTabId = null;
    }
  }

  // Bootstrap: only on first tool call. Reject extension/chrome pages so the
  // agent never pins its target to its own UI.
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  for (const tab of tabs) {
    if (tab.id && !isInternalChromeUrl(tab.url)) {
      targetTabId = tab.id;
      return tab;
    }
  }

  throw new Error(
    "No agent target tab. Call navigate(url) to open a work tab, or selectTab to choose one.",
  );
}

/**
 * Wait for a tab to finish loading after a navigation was triggered.
 * Always waits for the onUpdated "complete" event (never trusts current status
 * since navigation may not have started yet).
 */
export function waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timed out"));
    }, timeoutMs);

    function listener(
      updatedTabId: number,
      changeInfo: { status?: string },
    ) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500);
      }
    }

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
