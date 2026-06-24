import type { BrowserDriver, TabId } from "./driver";

/**
 * Shared screenshot capture for ALL model-facing images (the `screenshot`
 * tool and the CUA loop). Capturing the live tab via CDP rasterizes the page
 * DOM — INCLUDING OpenBrowse's own injected overlays (the "working on this
 * page" glow border + pill, click ripple, toasts, the SoM/visualizer
 * overlay). Those are human affordances; the model must never see them, or it
 * reasons about / clicks our own chrome and the overlays occlude real content.
 *
 * Every injected host lives on `document.documentElement` and shares the
 * `openbrowse-` id prefix, so we hide them all with a single
 * `visibility:hidden` style rule immediately around the capture, then remove
 * it. `visibility:hidden` (not `display:none`) keeps page layout stable so
 * only our chrome disappears — no reflow of the content the model sees.
 *
 * Overlay hide/restore is best-effort: a failure to inject/remove the style
 * (e.g. `Runtime.evaluate` unavailable, or a harness that injects no overlay)
 * never blocks the capture. The `finally` guarantees restore even if capture
 * throws.
 */

const HIDE_STYLE_ID = "openbrowse-capture-hide";

const HIDE_EXPRESSION = `(() => {
  if (document.getElementById(${JSON.stringify(HIDE_STYLE_ID)})) return;
  const s = document.createElement("style");
  s.id = ${JSON.stringify(HIDE_STYLE_ID)};
  s.textContent = '[id^="openbrowse-"]{visibility:hidden !important}';
  document.documentElement.appendChild(s);
})()`;

const RESTORE_EXPRESSION = `document.getElementById(${JSON.stringify(
  HIDE_STYLE_ID,
)})?.remove()`;

async function setOverlaysHidden(
  driver: BrowserDriver,
  tabId: TabId,
  hidden: boolean,
): Promise<void> {
  try {
    await driver.sendCommand(tabId, "Runtime.evaluate", {
      expression: hidden ? HIDE_EXPRESSION : RESTORE_EXPRESSION,
    });
  } catch {
    // Best-effort: never let overlay hiding/restoring break a capture.
  }
}

/**
 * Capture a tab screenshot with OpenBrowse overlays hidden, returning the
 * base64 PNG (no `data:` prefix). `params` is forwarded to
 * `Page.captureScreenshot` (defaults to `{ format: "png" }`).
 *
 * Retry strategy on the transient `-32000 Unable to capture screenshot`
 * error (renderer mid-paint, compositor not committing, throttled
 * background tab):
 *
 *   1. First attempt with the caller's params.
 *   2. On failure: retry IMMEDIATELY with `captureBeyondViewport: true`
 *      forced on, unless the caller already had it set. The off-screen
 *      renderer path doesn't depend on a fresh compositor frame, so it
 *      succeeds on tabs the compositor has paused — the dominant cause of
 *      the -32000 error in production. No 600 ms wait between attempts:
 *      the first attempt failed because of compositor state, not a
 *      mid-paint race, and waiting doesn't help the off-screen path.
 *
 * If the caller already passed `captureBeyondViewport: true` (the
 * `screenshot` tool's `fullPage` mode), the retry uses identical params
 * with a 600 ms settle wait — same shape as the legacy retry, since the
 * off-screen flip isn't an option.
 */
export async function captureScreenshot(
  driver: BrowserDriver,
  tabId: TabId,
  params: Record<string, unknown> = { format: "png" },
): Promise<string> {
  await setOverlaysHidden(driver, tabId, true);
  try {
    try {
      const r = await driver.sendCommand<{ data: string }>(
        tabId,
        "Page.captureScreenshot",
        params,
      );
      return r.data;
    } catch (firstErr) {
      // Pick the retry strategy. When the caller hasn't already enabled
      // captureBeyondViewport, flip it on for the retry: the off-screen
      // renderer path is robust to background-tab compositor pauses, which
      // is the dominant -32000 cause now that visibility-override lifts
      // most other throttling. When captureBeyondViewport was already on,
      // there's no further escape hatch — retry with identical params after
      // a short wait (legacy behavior).
      const alreadyBeyondViewport = params.captureBeyondViewport === true;
      const retryParams = alreadyBeyondViewport
        ? params
        : { ...params, captureBeyondViewport: true };
      if (alreadyBeyondViewport) {
        await new Promise((r) => setTimeout(r, 600));
      }
      try {
        const r = await driver.sendCommand<{ data: string }>(
          tabId,
          "Page.captureScreenshot",
          retryParams,
        );
        return r.data;
      } catch (secondErr) {
        if (secondErr instanceof Error && firstErr !== secondErr) {
          (secondErr as { cause?: unknown }).cause ??= firstErr;
        }
        throw secondErr;
      }
    }
  } finally {
    await setOverlaysHidden(driver, tabId, false);
  }
}
