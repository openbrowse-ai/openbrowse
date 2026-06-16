/**
 * Single source of truth for "which logical agent tab corresponds to which
 * `chrome.tabs.id` right now?"
 *
 * Why this exists
 * ===============
 * `chrome.tabs.id` is *not* a stable identifier for the page the agent is
 * working on. Chrome reassigns tab ids in at least three situations:
 *
 *   1. Speculation Rules / prerender activation. Many SPAs (Attio, Notion,
 *      Vercel, Google Search, X) prerender the next route; on activation
 *      Chrome fires `chrome.tabs.onReplaced(addedTabId, removedTabId)` and
 *      *also* fires `onRemoved(removedTabId)`. The page is the same; the
 *      integer id changes.
 *   2. Chrome restart. Tab ids are not stable across browser restarts.
 *   3. Tab discard + restore. Memory-pressure discarded tabs come back with
 *      a new id.
 *
 * Without a layer of indirection, every map keyed on `chrome.tabs.id` —
 * the agent's handle map (`tab-handles.ts`), the conversation ownership
 * bookkeeping (`tab-scoping.ts`), the cdp-session cache (`cdp-session.ts`),
 * and the persisted `Conversation.ownedLtids` array in chatDb (formerly
 * `ownedTabIds: number[]`) — would
 * silently corrupt on every replacement. The persistent symptom for the
 * agent is "Unknown tab handle" + "No tab with given id" mid-flow.
 *
 * What this module does
 * =====================
 * Mints stable opaque `LogicalTabId`s (UUIDs). Owns the only listener for
 * `chrome.tabs.onReplaced` in the codebase and consolidates the trailing
 * `chrome.tabs.onRemoved` Chrome fires for the replaced ctid (the
 * documented event order is `onReplaced` → `onRemoved(oldCtid)` — without
 * dedup, every consumer treats a replace as a removal).
 *
 * Consumers (tab-handles, tab-scoping, cdp-session, active-tab, cua-loop,
 * agent-transport) subscribe to the registry's `onReplace` and `onRemove`
 * events instead of installing their own `chrome.tabs.onRemoved` listeners.
 *
 * What this module does NOT do
 * ============================
 *  - chatDb persistence (lives in `tab-handles.ts` per-conversation)
 *  - tab ownership policy / side-panel UX (lives in `tab-scoping.ts`)
 *  - debugger session lifecycle (lives in `cdp-session.ts`)
 *
 * The registry is a *resolver* and an *event source*. Persistence and
 * policy stay in their existing homes; they just key on ltid now.
 */

export type LogicalTabId = string;
export type ChromeTabId = number;

export interface ReplaceEvent {
  ltid: LogicalTabId;
  oldCtid: ChromeTabId;
  newCtid: ChromeTabId;
}

export interface RemoveEvent {
  ltid: LogicalTabId;
  ctid: ChromeTabId;
}

type ReplaceListener = (e: ReplaceEvent) => void;
type RemoveListener = (e: RemoveEvent) => void;

/**
 * Window during which a trailing `onRemoved` for a just-replaced ctid is
 * suppressed. Chrome fires `onReplaced` then `onRemoved` synchronously, so
 * this only needs to be larger than 0; 5s is generous defense against
 * scheduler oddities.
 */
const REPLACE_DEDUP_WINDOW_MS = 5_000;

const ltidByCtid = new Map<ChromeTabId, LogicalTabId>();
const ctidByLtid = new Map<LogicalTabId, ChromeTabId>();

interface DedupEntry {
  ltid: LogicalTabId;
  expires: number;
}
const recentlyReplaced = new Map<ChromeTabId, DedupEntry>();

const replaceListeners = new Set<ReplaceListener>();
const removeListeners = new Set<RemoveListener>();

function now(): number {
  return Date.now();
}

function sweepExpired(): void {
  const t = now();
  for (const [ctid, entry] of recentlyReplaced) {
    if (entry.expires <= t) recentlyReplaced.delete(ctid);
  }
}

/**
 * Mint a fresh ltid. Uses `crypto.randomUUID()` when available (extension
 * runtime always has it; older test environments may not) and falls back
 * to a counter-based id under test.
 */
let testCounter = 0;
function mintLtid(): LogicalTabId {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  testCounter += 1;
  return `ltid-test-${testCounter}`;
}

function emitReplace(ev: ReplaceEvent): void {
  for (const fn of replaceListeners) {
    try {
      fn(ev);
    } catch (err) {
      console.warn("[tab-registry] onReplace subscriber threw", err);
    }
  }
}

function emitRemove(ev: RemoveEvent): void {
  for (const fn of removeListeners) {
    try {
      fn(ev);
    } catch (err) {
      console.warn("[tab-registry] onRemove subscriber threw", err);
    }
  }
}

/**
 * Mint or return the existing ltid for a chrome tab id. Idempotent: calling
 * with the same ctid multiple times returns the same ltid.
 */
function registerExisting(ctid: ChromeTabId): LogicalTabId {
  const existing = ltidByCtid.get(ctid);
  if (existing) return existing;
  const ltid = mintLtid();
  ltidByCtid.set(ctid, ltid);
  ctidByLtid.set(ltid, ctid);
  return ltid;
}

/**
 * Forget a logical tab. Idempotent.
 */
function unregister(ltid: LogicalTabId): void {
  const ctid = ctidByLtid.get(ltid);
  if (ctid != null) ltidByCtid.delete(ctid);
  ctidByLtid.delete(ltid);
}

function toChromeTabId(ltid: LogicalTabId): ChromeTabId | undefined {
  return ctidByLtid.get(ltid);
}

function toLogicalTabId(ctid: ChromeTabId): LogicalTabId | undefined {
  return ltidByCtid.get(ctid);
}

function onReplace(fn: ReplaceListener): () => void {
  replaceListeners.add(fn);
  return () => replaceListeners.delete(fn);
}

function onRemove(fn: RemoveListener): () => void {
  removeListeners.add(fn);
  return () => removeListeners.delete(fn);
}

/**
 * Internal: handle a `chrome.tabs.onReplaced(added, removed)` event.
 * Exported only as `__handleReplaceForTests` for unit tests; production
 * callers come from the chrome listener installed at module load.
 */
function handleReplace(addedCtid: ChromeTabId, removedCtid: ChromeTabId): void {
  sweepExpired();
  let ltid = ltidByCtid.get(removedCtid);
  if (!ltid) {
    // We weren't tracking the old ctid (e.g. replace fired for a tab the
    // agent hadn't bound yet). Mint a fresh ltid for the new ctid so
    // future tools can address it; emit no event (no consumers care about
    // an untracked tab's identity).
    registerExisting(addedCtid);
    return;
  }
  // Atomic re-key.
  ltidByCtid.delete(removedCtid);
  ltidByCtid.set(addedCtid, ltid);
  ctidByLtid.set(ltid, addedCtid);

  recentlyReplaced.set(removedCtid, {
    ltid,
    expires: now() + REPLACE_DEDUP_WINDOW_MS,
  });

  // Emit synchronously so subscribers (cdp-session invalidation,
  // tab-scoping side-panel re-registration, agent-transport working-glow
  // re-target) run in deterministic order before any other code reacts.
  emitReplace({ ltid, oldCtid: removedCtid, newCtid: addedCtid });

  // Best-effort URL for telemetry. Logged async so the synchronous emit
  // above never has to wait on a CDP round-trip; readers correlating logs
  // to events should match on `ltid`.
  //
  // The chrome.tabs.get shape is inlined as a minimal `{ url?: string }`
  // rather than `chrome.tabs.Tab` so this module typechecks in
  // `packages/bench` (which imports from `apps/extension/src/lib` without
  // pulling in `@types/chrome`).
  const tabsApi = (globalThis as { chrome?: { tabs?: { get?: (id: number) => Promise<{ url?: string } | undefined> } } })
    .chrome?.tabs?.get;
  if (tabsApi) {
    Promise.resolve(tabsApi(addedCtid))
      .then((tab) => {
        console.warn("[tab-registry] onReplaced", {
          url: tab?.url,
          ltid,
          oldCtid: removedCtid,
          newCtid: addedCtid,
        });
      })
      .catch(() => {
        console.warn("[tab-registry] onReplaced", {
          url: undefined,
          ltid,
          oldCtid: removedCtid,
          newCtid: addedCtid,
        });
      });
  } else {
    console.warn("[tab-registry] onReplaced", {
      url: undefined,
      ltid,
      oldCtid: removedCtid,
      newCtid: addedCtid,
    });
  }
}

/**
 * Internal: handle a `chrome.tabs.onRemoved(ctid)` event. Suppresses the
 * event when the ctid is in the recently-replaced dedup window.
 */
function handleRemove(ctid: ChromeTabId): void {
  sweepExpired();
  const dedup = recentlyReplaced.get(ctid);
  if (dedup && dedup.expires > now()) {
    // Trailing onRemoved that pairs with a recent onReplaced. Drop.
    recentlyReplaced.delete(ctid);
    return;
  }
  const ltid = ltidByCtid.get(ctid);
  if (!ltid) return; // never tracked; nothing to emit
  ltidByCtid.delete(ctid);
  ctidByLtid.delete(ltid);
  emitRemove({ ltid, ctid });
}

/** Reset internal *state* (handle maps, dedup window). Intended for tests
 *  that need a clean ltid namespace between cases but expect the
 *  application-level subscribers (tab-handles, tab-scoping, cdp-session)
 *  to keep working.
 *
 *  Listener lists are NOT cleared by this — that would silently break any
 *  module-level subscription that registered at import time. Tests that
 *  want a totally clean registry (e.g. the registry's own unit tests)
 *  call `__clearListenersForTests` in addition. */
function __resetForTests(): void {
  ltidByCtid.clear();
  ctidByLtid.clear();
  recentlyReplaced.clear();
  testCounter = 0;
}

/** Clear all subscriber lists. Tests-only escape hatch for the registry's
 *  own unit tests; production code should never call this. */
function __clearListenersForTests(): void {
  replaceListeners.clear();
  removeListeners.clear();
}

export const tabRegistry = {
  registerExisting,
  unregister,
  toChromeTabId,
  toLogicalTabId,
  onReplace,
  onRemove,
  // Test seams. Production callers come from chrome listeners.
  __handleReplaceForTests: handleReplace,
  __handleRemoveForTests: handleRemove,
  __resetForTests,
  __clearListenersForTests,
};

// Wire chrome's tab lifecycle events to the registry. This block runs at
// module load. Guarded so non-extension contexts (vitest with the minimal
// test-setup mock, or `packages/bench` imports) don't crash on undefined
// APIs; tests drive the registry via the `__handle*ForTests` seams instead.
//
// The chrome global shape is inlined as a structural type rather than
// `typeof chrome` so this module typechecks in `packages/bench` (no
// `@types/chrome` there). The structural shape covers exactly the listeners
// we need.
interface ChromeTabsLifecycleShape {
  tabs?: {
    onReplaced?: {
      addListener?: (
        cb: (addedTabId: number, removedTabId: number) => void,
      ) => void;
    };
    onRemoved?: {
      addListener?: (cb: (tabId: number) => void) => void;
    };
  };
}
const chromeRef = (globalThis as { chrome?: ChromeTabsLifecycleShape }).chrome;
if (chromeRef?.tabs?.onReplaced?.addListener) {
  chromeRef.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    handleReplace(addedTabId, removedTabId);
  });
}
if (chromeRef?.tabs?.onRemoved?.addListener) {
  chromeRef.tabs.onRemoved.addListener((tabId) => {
    handleRemove(tabId);
  });
}
