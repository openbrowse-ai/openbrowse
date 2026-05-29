/**
 * Window lifecycle helpers for the `incognito` isolation profile.
 *
 * `incognito` runs the subagent in a fresh incognito window so it
 * has no shared cookies / auth / storage with the user's normal profile.
 * The window is opened on subagent start and closed on subagent finish
 * (success, failure, cancellation) — the runner's `finally` block calls
 * `closeIncognitoWindow`.
 *
 * If the user has incognito disabled by policy, we throw an error
 * immediately so the subagent fails safely rather than silently leaking
 * state into a normal window.
 *
 * Defensive cleanup: on extension startup, the background scans for
 * conversations with `ephemeralWindowId != null && subagentStatus !==
 * "running"` and closes those windows — handles MV3 service-worker
 * death mid-run.
 *
 * The Chrome API surface is injected (rather than hard-imported) so
 * these helpers can be unit-tested without a live extension context.
 */

/**
 * Minimal subset of `chrome.windows` we need. Lets tests inject a fake.
 */
export interface WindowsAPI {
  create(opts: {
    incognito?: boolean;
    focused?: boolean;
    url?: string | string[];
  }): Promise<{ id?: number }>;
  remove(windowId: number): Promise<void>;
}

export interface IncognitoWindow {
  windowId: number;
}

/**
 * Open a fresh window for an incognito subagent run. Throws if
 * incognito is blocked by an enterprise / parental-control policy.
 */
export async function openIncognitoWindow(
  api: WindowsAPI,
): Promise<IncognitoWindow> {
  const created = await api.create({ incognito: true, focused: false });
  if (created.id == null) {
    throw new Error("openIncognitoWindow: chrome returned a window with no id");
  }
  return { windowId: created.id };
}

/**
 * Close an incognito window. Idempotent — a missing window (e.g. user
 * already closed it manually) is not an error.
 */
export async function closeIncognitoWindow(
  api: WindowsAPI,
  windowId: number,
): Promise<void> {
  try {
    await api.remove(windowId);
  } catch {
    // Window may have been closed by the user, or never existed in this
    // process (background restart). Silent no-op — the runner already
    // updated the conversation row.
  }
}

/**
 * Resolve the production `WindowsAPI` from the global `chrome` object.
 * Returns null when no extension API is present (tests, bench harness).
 */
export function getChromeWindowsAPI(): WindowsAPI | null {
  const w = (globalThis as unknown as {
    chrome?: {
      windows?: {
        create: (opts: unknown) => Promise<{ id?: number }>;
        remove: (id: number) => Promise<void>;
      };
    };
  }).chrome?.windows;
  if (!w) return null;
  return {
    create: (opts) => w.create(opts),
    remove: (id) => w.remove(id),
  };
}
