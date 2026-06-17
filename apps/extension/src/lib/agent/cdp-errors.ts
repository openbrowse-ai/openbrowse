/**
 * Side-effect-free CDP error utilities. Lives in its own module so tools
 * (`click-element`, `type-in-element`) can import these helpers without
 * pulling in `cdp-session.ts`'s top-level `chrome.debugger.onDetach` listener
 * registration — which would crash at import time in any non-extension
 * runtime (Node.js + Playwright, tests, etc.).
 */

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

/**
 * Patterns matching Chrome debugger errors that fire when a CDP frame-walking
 * call (e.g. `Accessibility.getFullAXTree`, `DOM.getDocument`) crosses into a
 * frame served from a `chrome-extension://` URL belonging to a DIFFERENT
 * extension than ours. Common in the wild: 1Password, LastPass, Bitwarden,
 * Honey, Grammarly all inject content-script iframes that our debugger isn't
 * allowed to inspect. Chrome surfaces this as e.g.
 *
 *   "Cannot access a chrome-extension:// URL of different extension"
 *
 * The session is NOT actually torn down by this — the specific call fails,
 * but the debugger remains attached. So we want to BAIL EARLY rather than
 * trigger the detach-and-retry recovery path (which would (a) thrash the
 * attach state for nothing and (b) try the same whole-frame-tree call again
 * and fail identically). Snapshot capture catches this and falls back to a
 * per-frame walk that excludes the offending frame.
 */
const CROSS_EXTENSION_FRAME_ERROR_PATTERNS = [
  /Cannot access a chrome-extension:\/\/ URL of different extension/i,
  /Cannot access (?:a )?contents? of (?:the )?(?:url|page) "chrome-extension:\/\//i,
];

export function isDetachError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // A cross-extension frame error is NOT a detach — classify it explicitly so
  // a future addition to the detach pattern list can't accidentally
  // re-enable the destructive retry path for this class.
  if (CROSS_EXTENSION_FRAME_ERROR_PATTERNS.some((re) => re.test(msg))) {
    return false;
  }
  return DETACH_ERROR_PATTERNS.some((re) => re.test(msg));
}

/**
 * True when `err` is the cross-extension frame access rejection. Callers
 * (snapshot-capture's per-frame walk, cdp-session's bail-early branch) use
 * this to switch to a degraded path that excludes the offending frame from
 * the AX walk, instead of treating it as a session-level failure.
 */
export function isCrossExtensionFrameError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CROSS_EXTENSION_FRAME_ERROR_PATTERNS.some((re) => re.test(msg));
}
