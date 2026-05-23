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

export function isDetachError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return DETACH_ERROR_PATTERNS.some((re) => re.test(msg));
}
