/**
 * Single owner of `chrome.debugger` state per tab.
 *
 * Why single-owner: Chrome enforces at most one extension-debugger client
 * per tab. Any code that calls `chrome.debugger.attach` is competing for
 * that slot, even within the same extension — Chrome rejects the second
 * attempt with `"Another debugger is already attached to the tab with
 * id: N."` (see `kAlreadyAttachedError` in Chromium's
 * `debugger_api.cc`). Two independent attachers in the same extension
 * (e.g. `cdp-session` and a separate `cdp-capture` module) would either
 * race or have to special-case-each-other's error strings — fragile and
 * already broken in practice (the old `msg.includes("Already attached")`
 * guard never matched Chrome's lowercase "already attached" message).
 *
 * Architecture:
 *   - `attach(tabId)` is idempotent: first call invokes
 *     `chrome.debugger.attach`; subsequent calls are no-ops.
 *   - `sendCommand` lazy-attaches if needed (preserved from the prior
 *     contract for ad-hoc per-tool callers like the extension driver).
 *   - `release(tabId)` is the only explicit detach path.
 *   - `releaseAll()` is what the agent-status "done working" hook calls.
 *   - `chrome.debugger.onDetach` (Chrome auto-detached us, e.g. on a
 *     cross-domain navigation, target replacement, or the user dismissing
 *     the "is being debugged" banner) drops the session entry and notifies
 *     subscribers via `onDetach(cb)`. cdp-capture subscribes here instead
 *     of attaching its own `chrome.debugger.onDetach` listener so all
 *     detach-driven bookkeeping converges on one event source.
 *
 * Consumers:
 *   - `extension-driver.ts` calls `sendCommand` for ad-hoc tool work
 *     (snapshot, click, type, executeOnPage, etc.).
 *   - `cdp-capture.ts` calls `attach` (eagerly) + `Network.enable` /
 *     `Runtime.enable` via `sendCommand`, and subscribes to `onDetach`
 *     for its flush-and-re-arm bookkeeping.
 *   - `agent-transport.ts` calls `releaseAll()` at done-working (replacing
 *     the old per-module `releaseAllCapture()` / `releaseAll` in
 *     cdp-session that had no production caller after T5).
 */

interface Session {
  tabId: number;
  attached: boolean;
  enabledDomains: Set<string>;
}

const sessions = new Map<number, Session>();
const pendingAttach = new Map<number, Promise<Session>>();
const NO_ENABLE_DOMAINS = new Set(["Input", "Page", "DOMSnapshot", "Runtime"]);

export { isDetachError } from "./cdp-errors";
import { isCrossExtensionFrameError, isDetachError } from "./cdp-errors";
import { tabRegistry } from "./tab-registry";

// --- structural chrome shape ----------------------------------------------
//
// We reach `chrome.debugger.*` and `chrome.tabs.onRemoved` through a
// minimal structural type rather than `typeof chrome` so this module
// typechecks in `packages/bench` (no `@types/chrome` there). Mirrors the
// pattern documented in `tab-registry.ts:298-326`. The shape covers
// exactly the surface this module uses; in production every property is
// non-null (the extension always has chrome.debugger), so the optional
// chains below behave like direct property access.

interface ChromeDebuggerShape {
  debugger?: {
    attach?: (target: { tabId: number }, version: string) => Promise<void>;
    detach?: (target: { tabId: number }) => Promise<void>;
    sendCommand?: (
      target: { tabId: number },
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>;
    onDetach?: {
      addListener?: (
        cb: (source: { tabId?: number }, reason: string | undefined) => void,
      ) => void;
    };
  };
  tabs?: {
    onRemoved?: {
      addListener?: (cb: (tabId: number) => void) => void;
    };
  };
}

/** Resolve `chrome` lazily. Tests stub `chrome` via `vi.stubGlobal` AFTER
 *  this module is imported, so capturing the reference at module-load
 *  would freeze the original (un-stubbed) value. Read at call time. */
function getChrome(): ChromeDebuggerShape | undefined {
  return (globalThis as { chrome?: ChromeDebuggerShape }).chrome;
}

/** Helper that throws a clean error if `chrome.debugger` is missing
 *  (non-extension runtime — bench, vitest without the chrome stub).
 *  Production extension always has it; the throw is unreachable there. */
function requireDebugger(): NonNullable<ChromeDebuggerShape["debugger"]> {
  const dbg = getChrome()?.debugger;
  if (!dbg) {
    throw new Error("chrome.debugger is unavailable (non-extension runtime)");
  }
  return dbg;
}

// --- onDetach pub/sub ------------------------------------------------------
//
// Chrome's `chrome.debugger.onDetach` fires when the browser severs the
// debugger session — most commonly on a cross-domain navigation, target
// replacement (Speculation Rules / prerender activation), or the user
// dismissing the "is being debugged" banner. Each module that cares about
// re-acting (e.g. cdp-capture's flush-and-re-arm) subscribes here, so we
// register exactly ONE underlying chrome.debugger.onDetach listener and
// fan it out — keeps the order of bookkeeping deterministic and the
// detach reason consistent for every subscriber.
type DetachListener = (tabId: number, reason: string | undefined) => void;
const detachSubscribers = new Set<DetachListener>();

export function onDetach(listener: DetachListener): () => void {
  detachSubscribers.add(listener);
  return () => detachSubscribers.delete(listener);
}

getChrome()?.debugger?.onDetach?.addListener?.((source, reason) => {
  if (source.tabId == null) return;
  // Drop our cached session BEFORE notifying subscribers so any subscriber
  // that calls `attach(tabId)` in response (e.g. cdp-capture's re-arm)
  // sees an empty session map and triggers a fresh attach rather than
  // short-circuiting on a stale entry.
  sessions.delete(source.tabId);
  if (reason && reason !== "canceled_by_user") {
    console.debug(
      `[cdp-session] tab ${source.tabId} detached: ${reason}`,
    );
  }
  // Snapshot the subscriber set before iterating so a subscriber that
  // unsubscribes itself in its callback (or adds a new one) doesn't mutate
  // the set we're walking.
  for (const cb of [...detachSubscribers]) {
    try {
      cb(source.tabId, reason);
    } catch (err) {
      console.debug(`[cdp-session] onDetach subscriber threw`, err);
    }
  }
});

// --- attach / release ------------------------------------------------------

/**
 * Attach the debugger to a tab. Idempotent — a second call for the same
 * tab returns the existing session without invoking `chrome.debugger.attach`
 * again. Concurrent calls coalesce on a single in-flight attach via
 * `pendingAttach`.
 *
 * Idempotency lives at this layer (not at the consumer) so that ad-hoc
 * tools and the always-on capture module cannot race the Chrome attach
 * slot — see the file-header note. The `"already attached"` error from
 * Chrome (case-insensitive: covers both Chrome's actual lowercase form
 * and any legacy capitalized variants) is treated as success; the
 * underlying session is still ours.
 */
export async function attach(tabId: number): Promise<Session> {
  const existing = sessions.get(tabId);
  if (existing?.attached) return existing;

  const pending = pendingAttach.get(tabId);
  if (pending) return pending;

  const promise = doAttach(tabId);
  pendingAttach.set(tabId, promise);
  try {
    return await promise;
  } finally {
    pendingAttach.delete(tabId);
  }
}

async function doAttach(tabId: number): Promise<Session> {
  try {
    await requireDebugger().attach!({ tabId }, "1.3");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Chrome's user-facing message is "Another debugger is already attached
    // to the tab with id: N." (lowercase "already"). Some older paths or
    // remote-host implementations emit "Already attached..." with a capital
    // A. Match either case-insensitively. Treating this as success is sound:
    // the slot is held under our extension id (the only path that emits
    // this error within the same extension), so commands sent on this
    // session will route to our existing client host.
    if (!/already attached/i.test(msg)) {
      throw new Error(`Cannot attach debugger to tab ${tabId}: ${msg}`);
    }
  }

  const session: Session = {
    tabId,
    attached: true,
    enabledDomains: new Set(),
  };
  sessions.set(tabId, session);
  return session;
}

/**
 * Detach the debugger from a tab and forget the session. No-op if the tab
 * isn't attached. Errors from `chrome.debugger.detach` are swallowed —
 * detach failures are typically "already detached" (target gone) and
 * non-actionable.
 *
 * Notifies `onDetach` subscribers synthetically. Chrome only fires its
 * own `chrome.debugger.onDetach` when IT severs the session (cross-domain
 * navigation, banner-dismiss, target replacement); explicit `detach`
 * calls from the extension don't generate that event. Synthesizing one
 * here gives subscribers a single semantic to handle: "this tab's session
 * is gone, clean up." The reason `"explicit_release"` (not in Chrome's
 * `DetachReason` enum, intentionally) lets subscribers distinguish.
 */
export function release(tabId: number): void {
  const session = sessions.get(tabId);
  if (!session) return;
  sessions.delete(tabId);
  if (session.attached) {
    requireDebugger().detach!({ tabId }).catch(() => {});
  }
  for (const cb of [...detachSubscribers]) {
    try {
      cb(tabId, "explicit_release");
    } catch (err) {
      console.debug(`[cdp-session] release subscriber threw`, err);
    }
  }
}

/**
 * Detach every attached tab. Called at agent done-working from
 * `agent-transport.resetAgentIndicator`. Replaces the prior
 * `cdp-capture.releaseAll()` and the orphaned `cdp-session.releaseAll()`
 * (both now collapse to this one).
 */
export function releaseAll(): void {
  for (const tabId of [...sessions.keys()]) {
    release(tabId);
  }
}

// --- sendCommand -----------------------------------------------------------

/**
 * Send a CDP command to a tab. Auto-attaches if the session isn't already
 * up. If the debugger session was silently detached mid-flight (e.g. by a
 * navigation that completed during the command), the first attempt fails
 * with `"Detached while handling command."`; we drop our stale session,
 * wait briefly for Chrome to settle, then re-attach and retry once.
 */
export async function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return sendCommandWithRetry<T>(tabId, method, params, /*allowRetry*/ true);
}

async function sendCommandWithRetry<T>(
  tabId: number,
  method: string,
  params: Record<string, unknown> | undefined,
  allowRetry: boolean,
): Promise<T> {
  const session = await attach(tabId);

  const domain = method.split(".")[0];
  if (!session.enabledDomains.has(domain) && !NO_ENABLE_DOMAINS.has(domain)) {
    try {
      await requireDebugger().sendCommand!({ tabId }, `${domain}.enable`);
      session.enabledDomains.add(domain);
    } catch (err) {
      // Cross-extension frame access errors do not mean the session is dead
      // — the debugger is still attached, only the specific call walked into
      // a chrome-extension:// frame from a different extension (commonly a
      // password manager iframe). Bail without touching the session map; the
      // caller (snapshot-capture) catches via isCrossExtensionFrameError and
      // falls back to a per-frame walk that excludes the offending frame.
      if (isCrossExtensionFrameError(err)) {
        throw err;
      }
      if (allowRetry && isDetachError(err)) {
        // Stale session — drop and retry once with a fresh attach.
        // Logged at debug; transient and self-healing, so most engineers
        // don't need to see it. Surfaces under DevTools Verbose for the
        // rare "flaky CUA click" investigation.
        console.debug(
          `[cdp-session] tab ${tabId} detached on ${domain}.enable for ` +
            `${method}; reattaching once`,
        );
        sessions.delete(tabId);
        return sendCommandWithRetry<T>(tabId, method, params, false);
      }
      // domain may not support enable; record so we don't try again
      session.enabledDomains.add(domain);
    }
  }

  try {
    const result = await requireDebugger().sendCommand!(
      { tabId },
      method,
      params ?? {},
    );
    return result as T;
  } catch (err) {
    // Same bail-early rationale as the .enable branch above: cross-extension
    // frame access is a per-call failure, not a session failure. Don't drop
    // the session, don't retry — let the caller pick a degraded path.
    if (isCrossExtensionFrameError(err)) {
      throw err;
    }
    if (allowRetry && isDetachError(err)) {
      // The debugger detached between attach() and sendCommand (or the
      // command itself fell off the wire mid-flight). Drop our stale session
      // record, give Chrome a moment to settle if a navigation is happening,
      // then re-attach and retry once.
      console.debug(
        `[cdp-session] tab ${tabId} detached during ${method}; reattaching ` +
          `and retrying once`,
      );
      sessions.delete(tabId);
      await new Promise((r) => setTimeout(r, 250));
      return sendCommandWithRetry<T>(tabId, method, params, false);
    }
    throw err;
  }
}

// --- registry-driven invalidation -----------------------------------------
//
// When a tab is replaced (Speculation Rules / prerender activation), Chrome
// silently detaches the debugger session attached to the OLD tabId.
// Subscribing to the registry's deduped `onReplace` means we drop the old
// session immediately; the next CDP call against the new ctid will lazy-
// attach via `attach()` above. We also subscribe to `onRemove` (which the
// registry only emits AFTER its dedup window confirms the tab truly
// closed) for symmetry — it strictly covers cases the existing
// `chrome.tabs.onRemoved` listener below does not, but in practice Chrome
// fires both for removals so this is just defense-in-depth.

getChrome()?.tabs?.onRemoved?.addListener?.((tabId) => {
  sessions.delete(tabId);
});

tabRegistry.onReplace(({ oldCtid }) => {
  sessions.delete(oldCtid);
});
tabRegistry.onRemove(({ ctid }) => {
  sessions.delete(ctid);
});

// --- test-only helper (stripped by tree-shaking in prod builds; harmless)
//
// Resets per-tab session state ONLY. We deliberately do NOT clear
// `detachSubscribers` here: subscribers (e.g. cdp-capture's onDetach
// handler) are registered once at module load and outlive any test's
// reset. Clearing them would leave cdp-capture deaf to detach events
// for the rest of the test run.
export function __test_reset(): void {
  sessions.clear();
  pendingAttach.clear();
}
