const IDLE_MS = 5000;

interface Session {
  tabId: number;
  attached: boolean;
  enabledDomains: Set<string>;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<number, Session>();
const pendingAttach = new Map<number, Promise<Session>>();
const NO_ENABLE_DOMAINS = new Set(["Input", "Page", "DOMSnapshot", "Runtime"]);

/**
 * Patterns matching Chrome debugger errors that indicate the underlying
 * session was lost (typically because the page navigated, the renderer
 * crashed, or another devtools client claimed the target). When we see one of
 * these, we should clear our cached session and re-attach.
 */
const DETACH_ERROR_PATTERNS = [
  /Detached while handling command/i,
  /Debugger is not attached/i,
  /Cannot find context with specified id/i,
  /Target closed/i,
  /No tab with given id/i,
];

function isDetachError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return DETACH_ERROR_PATTERNS.some((re) => re.test(msg));
}

/**
 * Track Chrome's own detach events. Chrome auto-detaches the debugger on
 * navigation, target replacement, or when the user dismisses the "is being
 * debugged" banner. Without this listener our session map stays stale and the
 * NEXT sendCommand will fail with "Detached while handling command."
 */
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  const session = sessions.get(source.tabId);
  if (!session) return;
  // Mark detached but keep the entry briefly — sendCommand will re-attach on
  // demand. The reason field is informational only.
  session.attached = false;
  session.enabledDomains.clear();
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
  // Clear from map so a fresh attach() runs cleanly.
  sessions.delete(source.tabId);
  // Log reason for debugging the next class of routing bug; not user-facing.
  if (reason && reason !== "canceled_by_user") {
    console.debug(
      `[cdp-session] tab ${source.tabId} detached: ${reason}`,
    );
  }
});

async function attach(tabId: number): Promise<Session> {
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
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Already attached")) {
      throw new Error(`Cannot attach debugger to tab ${tabId}: ${msg}`);
    }
  }

  const session: Session = {
    tabId,
    attached: true,
    enabledDomains: new Set(),
    idleTimer: null,
  };
  sessions.set(tabId, session);
  return session;
}

function resetIdleTimer(session: Session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    releaseSession(session.tabId);
  }, IDLE_MS);
}

/**
 * Send a CDP command to a tab. If the debugger session was silently detached
 * (e.g. by a navigation that completed mid-call), the first attempt will fail
 * with a "Detached while handling command" error. We catch that, drop the
 * stale session, re-attach, and retry once.
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
  resetIdleTimer(session);

  const domain = method.split(".")[0];
  if (!session.enabledDomains.has(domain) && !NO_ENABLE_DOMAINS.has(domain)) {
    try {
      await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
      session.enabledDomains.add(domain);
    } catch (err) {
      if (allowRetry && isDetachError(err)) {
        // Stale session — drop and retry once with a fresh attach.
        sessions.delete(tabId);
        return sendCommandWithRetry<T>(tabId, method, params, false);
      }
      // domain may not support enable; record so we don't try again
      session.enabledDomains.add(domain);
    }
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      method,
      params ?? {},
    );
    return result as T;
  } catch (err) {
    if (allowRetry && isDetachError(err)) {
      // The debugger detached between attach() and sendCommand (or the
      // command itself fell off the wire mid-flight). Drop our stale session
      // record, give Chrome a moment to settle if a navigation is happening,
      // then re-attach and retry once.
      sessions.delete(tabId);
      await new Promise((r) => setTimeout(r, 250));
      return sendCommandWithRetry<T>(tabId, method, params, false);
    }
    throw err;
  }
}

export function releaseSession(tabId: number): void {
  const session = sessions.get(tabId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  sessions.delete(tabId);
  if (session.attached) {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

export function releaseAll(): void {
  for (const tabId of [...sessions.keys()]) {
    releaseSession(tabId);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId);
});
