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
 * Includes one short retry on the transient `-32000 Unable to capture
 * screenshot` CDP error seen when the renderer is mid-paint or throttled.
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
    } catch {
      await new Promise((r) => setTimeout(r, 600));
      const r = await driver.sendCommand<{ data: string }>(
        tabId,
        "Page.captureScreenshot",
        params,
      );
      return r.data;
    }
  } finally {
    await setOverlaysHidden(driver, tabId, false);
  }
}
