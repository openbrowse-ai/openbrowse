/**
 * Per-tab ring buffer of CDP network requests and console messages.
 *
 * A single `chrome.debugger.onEvent` listener (registered at module load,
 * below) routes events for tracked tabs into the buffer. Cross-domain
 * detach handling subscribes to `cdp-session.onDetach` (NOT directly to
 * `chrome.debugger.onDetach`): cdp-session is the single owner of the
 * Chrome debugger session, and capture acts as one of its event consumers.
 *
 * Lifecycle:
 *   - `startCapture(tabId)` calls `cdp-session.attach(tabId)` (idempotent)
 *     then enables the Network and Runtime CDP domains via cdp-session's
 *     sendCommand. The tab is marked tracked so events route here.
 *   - `stopCapture(tabId)` removes the tab from the tracked set without
 *     detaching the underlying session — the session is owned by
 *     cdp-session and torn down via `cdp-session.releaseAll()` at done-
 *     working from agent-transport's `resetAgentIndicator`.
 *   - `releaseAll()` is a thin compatibility shim that just clears the
 *     tracked set and our buffers; the canonical "drop everything" call
 *     is `cdp-session.releaseAll()`, which fires our onDetach handler
 *     for each released tab and tears down its buffers symmetrically.
 *
 * Why we don't own attach: prior to this, capture and cdp-session each
 * called `chrome.debugger.attach` independently with private state maps.
 * Chrome enforces a single debugger client per tab; the second `attach`
 * would reject with `"Another debugger is already attached to the tab
 * with id: N"`, and our defensive `msg.includes("Already attached")`
 * guard never matched (Chrome's message is lowercase "already attached").
 * Centralizing attach in cdp-session removes the entire class of bug.
 */


const BUFFER_CAP = 200;
const DEFAULT_LIMIT = 100;

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  fromCache?: boolean;
  failed?: boolean;
  errorText?: string;
  ts: number;
}

export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  url?: string;
  lineNumber?: number;
  ts: number;
}

interface TabCapture {
  tabId: number;
  origin: string;
  requests: NetworkEntry[];
  consoles: ConsoleEntry[];
}

const captures = new Map<number, TabCapture>();

function ensure(tabId: number): TabCapture {
  let c = captures.get(tabId);
  if (!c) {
    c = { tabId, origin: "", requests: [], consoles: [] };
    captures.set(tabId, c);
  }
  return c;
}

function pushCapped<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > BUFFER_CAP) arr.shift();
}

export interface ReadNetworkOpts {
  urlPattern?: string;
  limit?: number;
  clear?: boolean;
}

export function readNetwork(
  tabId: number,
  opts: ReadNetworkOpts,
): { requests: NetworkEntry[]; total: number; captured: boolean } {
  const c = captures.get(tabId);
  if (!c) return { requests: [], total: 0, captured: false };
  let rows = c.requests;
  if (opts.urlPattern) {
    const needle = opts.urlPattern;
    rows = rows.filter((r) => r.url.includes(needle));
  }
  const total = rows.length;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const out = rows.slice(Math.max(0, rows.length - limit));
  if (opts.clear) c.requests = [];
  return { requests: out, total, captured: true };
}

export interface ReadConsoleOpts {
  pattern?: string;
  onlyErrors?: boolean;
  limit?: number;
  clear?: boolean;
}

export function readConsole(
  tabId: number,
  opts: ReadConsoleOpts,
): { messages: ConsoleEntry[]; total: number; captured: boolean } {
  const c = captures.get(tabId);
  if (!c) return { messages: [], total: 0, captured: false };
  let rows = c.consoles;
  if (opts.onlyErrors) rows = rows.filter((m) => m.level === "error");
  if (opts.pattern) {
    // The agent supplies the pattern through its tool-call schema. We
    // length-cap to keep pathological backtracking out of the SW
    // (catastrophic ReDoS would freeze the worker until the regex
    // engine gives up); on a malformed pattern we filter to no matches
    // rather than throw, so an invalid argument doesn't poison the
    // tool result the agent is trying to read. The contract on
    // read_console_messages is "regex over message text"; substring
    // matching is one common use of that contract and works as-is via
    // a literal pattern.
    const PATTERN_CAP = 256;
    const pat =
      opts.pattern.length > PATTERN_CAP
        ? opts.pattern.slice(0, PATTERN_CAP)
        : opts.pattern;
    let re: RegExp | null = null;
    try {
      re = new RegExp(pat);
    } catch {
      re = null;
    }
    rows = re ? rows.filter((m) => re.test(m.text)) : [];
  }
  const total = rows.length;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const out = rows.slice(Math.max(0, rows.length - limit));
  if (opts.clear) c.consoles = [];
  return { messages: out, total, captured: true };
}

// --- CDP event mapping (Task 2): translate raw CDP events into capture buffers ---
const CONSOLE_LEVEL: Record<string, ConsoleEntry["level"]> = {
  log: "log", info: "info", warning: "warn", error: "error", debug: "debug",
  dir: "log", trace: "debug", assert: "error",
};

function argsToText(args: unknown): string {
  if (!Array.isArray(args)) return "";
  return args
    .map((a) => {
      const v = a as { value?: unknown; description?: string };
      if (v.description !== undefined) return v.description;
      if (v.value !== undefined) return String(v.value);
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Apply one CDP event to a tab's buffers. Exported for unit testing and called
 * by the `chrome.debugger.onEvent` listener (registered below).
 */
export function handleCdpEvent(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
): void {
  const c = ensure(tabId);
  switch (method) {
    case "Network.requestWillBeSent": {
      const req = (params.request ?? {}) as { url?: string; method?: string };
      pushCapped(c.requests, {
        requestId: String(params.requestId ?? ""),
        url: req.url ?? "",
        method: req.method ?? "",
        resourceType: String(params.type ?? "Other"),
        ts: Date.now(),
      });
      break;
    }
    case "Network.responseReceived": {
      const id = String(params.requestId ?? "");
      const resp = (params.response ?? {}) as {
        status?: number; statusText?: string; fromDiskCache?: boolean;
      };
      const entry = c.requests.find((r) => r.requestId === id);
      if (entry) {
        entry.status = resp.status;
        entry.statusText = resp.statusText;
        entry.fromCache = resp.fromDiskCache;
      }
      break;
    }
    case "Network.loadingFailed": {
      const id = String(params.requestId ?? "");
      const entry = c.requests.find((r) => r.requestId === id);
      if (entry) {
        entry.failed = true;
        entry.errorText = String(params.errorText ?? "failed");
      }
      break;
    }
    case "Runtime.consoleAPICalled": {
      pushCapped(c.consoles, {
        level: CONSOLE_LEVEL[String(params.type ?? "log")] ?? "log",
        text: argsToText(params.args),
        ts: Date.now(),
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const det = (params.exceptionDetails ?? {}) as {
        text?: string; exception?: { description?: string };
      };
      pushCapped(c.consoles, {
        level: "error",
        text: det.exception?.description ?? det.text ?? "Uncaught exception",
        ts: Date.now(),
      });
      break;
    }
  }
}

/** Empty a tab's buffers without untracking it (cross-domain navigation). */
export function flushTab(tabId: number): void {
  const c = captures.get(tabId);
  if (!c) return;
  c.requests = [];
  c.consoles = [];
}

// --- Lifecycle ------------------------------------------------------------
//
// `tracked` is a routing flag, not an ownership claim: the underlying
// `chrome.debugger` session is owned by `cdp-session.ts`. A tab is in
// `tracked` iff capture's onEvent handler should write incoming events
// into this module's buffers. We never call `chrome.debugger.attach` /
// `detach` directly from this file — see the file-header note.

import {
  attach as cdpAttach,
  sendCommand as cdpSendCommand,
  onDetach as cdpOnDetach,
} from "./cdp-session";

const tracked = new Set<number>();

/**
 * In-flight startCapture promises, keyed by tabId. Concurrent callers
 * with the same tabId share one promise so the second caller doesn't
 * see a half-initialized session.
 *
 * Without this, the previous implementation's `if (tracked.has(tabId))
 * return; tracked.add(tabId);` check let a second caller see `tracked`
 * true after only the synchronous mark — but before `cdpAttach` and
 * `Network.enable`/`Runtime.enable` had completed. The second caller
 * would return immediately, then any CDP commands it issued in the
 * next tick could race the unfinished domain-enable round-trip and
 * miss a window of events. Mirrors `cdp-session.ts`'s `pendingAttach`
 * pattern.
 *
 * `tracked` is still set synchronously at the start of startCapture so
 * the onEvent listener routes events as soon as they arrive (the
 * domain-enable round-trip is a strict superset of the moment Chrome
 * starts emitting events for that tab). The pending map is used only
 * to coalesce *callers waiting on initialization*.
 */
const pendingStartups = new Map<number, Promise<void>>();

/**
 * Begin capturing network + console for a tab. Idempotent — a second call
 * for the same tab returns the same in-flight promise (or a no-op promise
 * once startup completes). Acquires the underlying debugger session via
 * `cdp-session.attach` (which itself is idempotent across concurrent
 * ad-hoc tools and capture), then enables the Network and Runtime CDP
 * domains via cdp-session's sendCommand so console + exception events
 * flow.
 *
 * Best-effort: if `Network.enable` / `Runtime.enable` rejects (e.g. mid-
 * navigation), capture stays armed but may miss events until Chrome
 * settles. The next CDP call from any consumer will re-enable on demand
 * via cdp-session's auto-reattach retry path.
 */
export async function startCapture(tabId: number): Promise<void> {
  if (tracked.has(tabId)) return;
  const inflight = pendingStartups.get(tabId);
  if (inflight) return inflight;
  // Mark as tracked synchronously so the onEvent listener routes events
  // for this tab as soon as Chrome starts delivering them — events that
  // arrive after `chrome.debugger.attach` resolves but before
  // `Network.enable` does land in the buffer (they'll just be sparse
  // until `Network.enable` actually flips the spigot fully open).
  // Without the synchronous mark, the re-arm's onEvent in cdp-capture's
  // detach handler would drop the first events of the new domain.
  tracked.add(tabId);
  ensure(tabId);
  const promise = (async () => {
    try {
      await cdpAttach(tabId);
    } catch (err) {
      // cdp-session.attach already treats Chrome's "already attached"
      // form as success; anything reaching here is a genuine attach
      // failure (tab gone, restricted target). Drop bookkeeping so
      // reads return captured:false and a future caller can retry.
      tracked.delete(tabId);
      captures.delete(tabId);
      throw err;
    }
    try {
      await cdpSendCommand(tabId, "Network.enable");
      await cdpSendCommand(tabId, "Runtime.enable");
    } catch {
      // Domain enable can fail transiently on navigation. Leave the
      // tab in `tracked`; events that DO arrive will still be
      // captured, and the next sendCommand from any consumer will
      // re-enable on demand via cdp-session's auto-reattach retry path.
    }
  })();
  pendingStartups.set(tabId, promise);
  try {
    await promise;
  } finally {
    pendingStartups.delete(tabId);
  }
}

/**
 * Stop capturing a tab: forget our routing flag and drop its buffers.
 * Does NOT detach the underlying debugger session — that belongs to
 * cdp-session. Ad-hoc tool callers may still need the session up; the
 * canonical "tear down everything" path is `cdp-session.releaseAll()` at
 * agent done-working.
 */
export function stopCapture(tabId: number): void {
  if (!tracked.has(tabId)) return;
  tracked.delete(tabId);
  captures.delete(tabId);
}

/**
 * Compatibility shim: clear all capture-side bookkeeping. Existing callers
 * in `agent-transport.resetAgentIndicator` import this as
 * `releaseAllCapture` and call it alongside the indicator hide. With the
 * unified architecture, the canonical detach path is
 * `cdp-session.releaseAll()` — but for clarity at the call site we keep
 * a capture-side entry point that drops the routing flags. Detach for
 * each tab still happens via cdp-session.releaseAll which fires our
 * onDetach handler symmetrically.
 */
export function releaseAll(): void {
  tracked.clear();
  captures.clear();
  pendingStartups.clear();
}

/** Whether a tab is currently being captured. */
export function isCapturing(tabId: number): boolean {
  return tracked.has(tabId);
}

// --- Listener registration ------------------------------------------------
//
// Route every CDP event for a *tracked* tab to handleCdpEvent. Untracked
// tabs (the user's own tabs, internal pages) are ignored — their events
// never reach the buffer. The listener is registered once at module load.
//
// The chrome global is reached via a structural shape rather than
// `typeof chrome` so this module typechecks in `packages/bench` (no
// `@types/chrome` there). Mirrors the pattern in `tab-registry.ts`.
// Resolved lazily (call time) so vitest's `vi.stubGlobal("chrome", …)`
// in beforeEach takes effect even though it runs after module load.
interface ChromeOnEventShape {
  debugger?: {
    onEvent?: {
      addListener?: (
        cb: (
          source: { tabId?: number },
          method: string,
          params?: object,
        ) => void,
      ) => void;
    };
  };
}
function getChrome(): ChromeOnEventShape | undefined {
  return (globalThis as { chrome?: ChromeOnEventShape }).chrome;
}
getChrome()?.debugger?.onEvent?.addListener?.((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null || !isCapturing(tabId)) return;
  handleCdpEvent(tabId, method, (params ?? {}) as Record<string, unknown>);
});

// On cross-domain navigation / target replacement / banner-dismiss, Chrome
// auto-detaches the debugger. cdp-session is the single source of truth
// for that event; we subscribe to its `onDetach` rather than attaching
// our own `chrome.debugger.onDetach` listener so the order of state
// teardown is deterministic (cdp-session drops its session entry FIRST,
// then we run).
//
// Behavior on detach:
//   - Explicit release (`reason === "explicit_release"`): the caller
//     (typically agent-transport's done-working hook) is intentionally
//     tearing the session down. Drop our routing flags + buffers and
//     DO NOT re-arm.
//   - User canceled (`reason === "canceled_by_user"`): the user clicked
//     "Cancel" on Chrome's "is being debugged" banner. Re-attaching
//     would just be rejected by Chrome (the user's intent is "stop
//     debugging this tab"), so we treat this as terminal too. Without
//     this branch the re-arm path would call cdpAttach, fail, and
//     surface a noisy error to the agent on every dismissed banner.
//   - Chrome auto-detached (any other reason — most commonly cross-
//     domain navigation, target replacement, or banner-timeout): flush
//     this tab's buffers, drop from `tracked` so the re-arm's
//     idempotency guard is bypassed, then re-acquire the session via
//     startCapture. This matches the "cleared on cross-domain
//     navigation" semantics while keeping eager capture armed across
//     navigations.
cdpOnDetach((tabId, reason) => {
  if (!isCapturing(tabId)) return;
  if (reason === "explicit_release" || reason === "canceled_by_user") {
    tracked.delete(tabId);
    captures.delete(tabId);
    return;
  }
  flushTab(tabId);
  tracked.delete(tabId);
  void startCapture(tabId);
});

// --- test-only helpers (stripped by tree-shaking in prod builds; harmless) ---
export function __test_pushNetwork(tabId: number, e: NetworkEntry): void {
  pushCapped(ensure(tabId).requests, e);
}
export function __test_pushConsole(tabId: number, e: ConsoleEntry): void {
  pushCapped(ensure(tabId).consoles, e);
}
export function __test_reset(): void {
  captures.clear();
  tracked.clear();
  pendingStartups.clear();
}
