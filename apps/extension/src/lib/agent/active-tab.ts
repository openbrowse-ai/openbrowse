import { tabRegistry, type LogicalTabId } from "./tab-registry";

/**
 * Per-conversation pinned target ltid. Replaces the pre-SW-host module-
 * scope singleton, which clobbered across parallel agent runs (two
 * chats in two different windows would steal each other's target as
 * they alternated tool calls). Each agent run keys on its own
 * `conversationId`.
 *
 * Keying on ltid (not ctid) makes the target survive `chrome.tabs
 * .onReplaced` (Speculation Rules / prerender activation): the registry
 * re-keys the ltid → newCtid mapping atomically, so the next
 * `getActiveUserTab()` resolves to the new ctid without any code here
 * needing to react.
 */
const targetLtidByCid = new Map<string, LogicalTabId>();

/**
 * Fallback target ltid used by callers that don't supply a
 * `conversationId`. The tests and a few legacy renderer-side callers
 * fall into this bucket; the SW-host agent loop always supplies a cid
 * via `agent-transport`'s context.
 */
let fallbackTargetLtid: LogicalTabId | null = null;

/**
 * Resolve the cid to read/write target state under. Explicit arg wins;
 * otherwise we lazy-import the agent-transport context (avoiding a
 * static import cycle with this module). When neither resolves, we
 * fall back to the legacy singleton slot.
 */
async function resolveCidAsync(
  conversationId: string | null | undefined,
): Promise<string | null> {
  if (conversationId !== undefined && conversationId !== null) {
    return conversationId;
  }
  try {
    const { getAgentContext } = await import("./agent-transport");
    return getAgentContext().conversationId ?? null;
  } catch {
    return null;
  }
}

/**
 * Sync variant of `resolveCidAsync` for hot paths that can't await.
 * Tries the same fallback chain but skips the lazy import — agent-transport
 * is always loaded by the time tools run, so the dynamic import would
 * resolve from the module cache synchronously anyway. We can't return
 * a Promise here, so callers that need a sync cid pass it explicitly.
 */
function resolveCidSync(
  conversationId: string | null | undefined,
): string | null {
  if (conversationId !== undefined && conversationId !== null) {
    return conversationId;
  }
  // Read from the already-loaded agent-transport module if available.
  // `require`/`import.meta` isn't available in our ESM bundle; the
  // simplest approach is to keep a small registered callback that
  // agent-transport sets at startup (see `registerCidResolver` below).
  try {
    return cidResolver?.() ?? null;
  } catch {
    return null;
  }
}

let cidResolver: (() => string | null) | null = null;

/**
 * Register a synchronous cid lookup function. Called by agent-transport
 * at module load so this module doesn't need a static import (avoiding
 * a cycle). The resolver returns the current `agentConversationId`
 * (which is set by `setAgentContext` at run start).
 */
export function registerCidResolver(fn: () => string | null): void {
  cidResolver = fn;
}

/**
 * Get the current target chrome tab id for a conversation. Compatibility
 * shim for the extension-driver / tools that still want a ctid; resolves
 * the pinned ltid through the registry. Returns null if no target is set
 * or the pinned ltid no longer resolves to a live tab.
 *
 * Pass `conversationId` to read a specific run's target; omit for the
 * fallback / module-cached cid (set via `registerCidResolver`).
 */
export function getTargetTabId(
  conversationId?: string | null,
): number | null {
  const cid = resolveCidSync(conversationId);
  const ltid = cid != null ? targetLtidByCid.get(cid) ?? null : fallbackTargetLtid;
  if (ltid == null) return null;
  return tabRegistry.toChromeTabId(ltid) ?? null;
}

/** Get the current target LogicalTabId (or null when unset). */
export function getTargetLtid(
  conversationId?: string | null,
): LogicalTabId | null {
  const cid = resolveCidSync(conversationId);
  if (cid == null) return fallbackTargetLtid;
  return targetLtidByCid.get(cid) ?? null;
}

/**
 * Set a specific tab as the target for tool operations. Takes a chrome
 * tab id for caller convenience; minted/recovered to an ltid via the
 * registry so subsequent operations key on the stable identifier.
 *
 * Pass `null` to clear.
 */
export function setTargetTabId(
  tabId: number | null,
  conversationId?: string | null,
) {
  const cid = resolveCidSync(conversationId);
  if (tabId == null) {
    if (cid != null) targetLtidByCid.delete(cid);
    else fallbackTargetLtid = null;
    return;
  }
  const ltid = tabRegistry.registerExisting(tabId);
  if (cid != null) targetLtidByCid.set(cid, ltid);
  else fallbackTargetLtid = ltid;
}

/** Set a specific LogicalTabId as the target. Used by callers that
 *  already have an ltid (e.g. handle-resolver paths). */
export function setTargetLtid(
  ltid: LogicalTabId | null,
  conversationId?: string | null,
) {
  const cid = resolveCidSync(conversationId);
  if (ltid == null) {
    if (cid != null) targetLtidByCid.delete(cid);
    else fallbackTargetLtid = null;
    return;
  }
  if (cid != null) targetLtidByCid.set(cid, ltid);
  else fallbackTargetLtid = ltid;
}

/**
 * Clear all per-conversation target state. Used by tests; production
 * callers should pass a specific `conversationId` to `setTargetTabId(null, cid)`.
 *
 * Also resets `cidResolver` — without this, a resolver registered by a
 * prior test (via `setCidResolver`) would still resolve later tests'
 * "default cid" lookups, leaking state across the file.
 */
export function __resetActiveTabForTests(): void {
  targetLtidByCid.clear();
  fallbackTargetLtid = null;
  cidResolver = null;
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
 *  1. Explicit tracked target for `conversationId` (the pinned ltid,
 *     resolved through the registry).
 *  2. First-call bootstrap: the active tab in `windowId` (preferred) or
 *     in the current window, but ONLY if it's a real web page (not an
 *     extension page or chrome://). The bootstrap result is registered
 *     with the registry to mint an ltid that's then pinned.
 *
 * We never fall back to `{active: true}` once a target exists — that was the
 * root cause of tool calls executing against the user's pinned home.html view
 * instead of the agent's tracked tab.
 *
 * @param opts.conversationId  The cid whose target to read/set. Falls back to
 *   the registered cid resolver, then to the fallback slot.
 * @param opts.windowId  When bootstrapping, scope the `{active: true}` query
 *   to this window instead of `currentWindow: true`. This is what fixes
 *   the parallel-windows leak: each conversation bootstraps to a tab in
 *   ITS window, not whichever window has Chrome's focus.
 */
export async function getActiveUserTab(opts: {
  conversationId?: string | null;
  windowId?: number;
} = {}): Promise<chrome.tabs.Tab> {
  const cid = await resolveCidAsync(opts.conversationId);
  const pinned = cid != null ? targetLtidByCid.get(cid) : fallbackTargetLtid;

  if (pinned != null) {
    const ctid = tabRegistry.toChromeTabId(pinned);
    if (ctid != null) {
      try {
        const tab = await chrome.tabs.get(ctid);
        if (tab) return tab;
      } catch {
        // Tracked tab no longer exists; clear and fall through to bootstrap.
        if (cid != null) targetLtidByCid.delete(cid);
        else fallbackTargetLtid = null;
      }
    } else {
      // Registry can't resolve the pinned ltid (e.g. SW restart hasn't
      // re-registered it yet). Clear and bootstrap.
      if (cid != null) targetLtidByCid.delete(cid);
      else fallbackTargetLtid = null;
    }
  }

  // Bootstrap: only on first tool call. Reject extension/chrome pages so the
  // agent never pins its target to its own UI. Scope the query to the
  // conversation's window when we have one; otherwise legacy focused-window
  // fallback.
  //
  // Window resolution order: explicit `opts.windowId` → lazy resolve via
  // `conversation-window.resolveConversationWindowId(cid)` → legacy
  // `currentWindow: true`. The lazy step is what makes this work without
  // every driver caller passing a window id explicitly: cid alone is
  // enough to pin the bootstrap to the conversation's correct window.
  let scopedWindowId: number | undefined = opts.windowId;
  if (scopedWindowId === undefined && cid != null) {
    try {
      // Variable indirection (instead of a string-literal `import(...)`)
      // is deliberate: it hides this module from tsc's static module-graph
      // walk so consumers that compile against a subset of the extension's
      // source tree (notably `packages/bench`, which has no `@/*` path
      // alias and no chrome ambient types) don't transitively typecheck
      // `conversation-window.ts` + its `chatDb` / `storage` / `chrome.*`
      // dependencies. The runtime resolution is unaffected — extension
      // bundlers (Vite/Rollup/wxt) follow the call dynamically and ship
      // the module as a chunk. The module never executes in bench (gated
      // upstream by `isServiceWorkerContext`), so the type opacity is a
      // pure compile-time hygiene win, not a behavioural change.
      const modulePath: string = "./conversation-window";
      const mod = (await import(modulePath)) as {
        resolveConversationWindowId: (
          cid: string,
        ) => Promise<number | undefined>;
      };
      scopedWindowId = await mod.resolveConversationWindowId(cid);
    } catch {
      // best-effort; legacy fallback below.
    }
  }
  const query: chrome.tabs.QueryInfo = { active: true };
  if (scopedWindowId !== undefined) {
    query.windowId = scopedWindowId;
  } else {
    query.currentWindow = true;
  }
  const tabs = await chrome.tabs.query(query);
  for (const tab of tabs) {
    if (tab.id && !isInternalChromeUrl(tab.url)) {
      const ltid = tabRegistry.registerExisting(tab.id);
      if (cid != null) targetLtidByCid.set(cid, ltid);
      else fallbackTargetLtid = ltid;
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
