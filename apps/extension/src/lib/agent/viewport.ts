import type { BrowserDriver, TabId } from "./driver";

/**
 * Live viewport metrics needed to map element coordinates from the document
 * (returned by `DOM.getBoxModel` etc.) into the visual viewport (which is
 * what `Input.dispatchMouseEvent` and `DOM.getNodeForLocation` interpret).
 *
 * Without this conversion, elements below the fold receive clicks at
 * y-coordinates outside the visible area and CDP silently no-ops the
 * dispatch — see `tools/click-element.ts` for the original bug.
 */
export interface ViewportMetrics {
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
}

/**
 * Read live `{scrollX, scrollY, innerWidth, innerHeight}` via CDP
 * `Runtime.evaluate`. Falls back to zero scroll + zero size if the
 * evaluation fails (e.g. the page is between navigations) — callers should
 * treat the result as best-effort.
 */
export async function readViewportMetrics(
  driver: BrowserDriver,
  tabId: TabId,
): Promise<ViewportMetrics> {
  try {
    const result = await driver.sendCommand<{
      result?: {
        value?: {
          sx: number;
          sy: number;
          iw: number;
          ih: number;
        };
      };
    }>(tabId, "Runtime.evaluate", {
      expression:
        "({ sx: window.scrollX, sy: window.scrollY, iw: window.innerWidth, ih: window.innerHeight })",
      returnByValue: true,
    });
    const v = result.result?.value;
    if (!v) return { scrollX: 0, scrollY: 0, innerWidth: 0, innerHeight: 0 };
    return {
      scrollX: v.sx,
      scrollY: v.sy,
      innerWidth: v.iw,
      innerHeight: v.ih,
    };
  } catch {
    return { scrollX: 0, scrollY: 0, innerWidth: 0, innerHeight: 0 };
  }
}

/**
 * Scroll an element into view via CDP `DOM.scrollIntoViewIfNeeded`. Best-
 * effort: returns true on success, false if the call fails (e.g. detached
 * node, missing CDP support). Callers should re-read the box model after a
 * successful scroll because the element's viewport coordinates will have
 * changed.
 */
export async function scrollIntoViewIfNeeded(
  driver: BrowserDriver,
  tabId: TabId,
  backendNodeId: number,
): Promise<boolean> {
  try {
    await driver.sendCommand(tabId, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the renderer to commit pending layout/scroll changes by waiting
 * two animation frames inside the page. Used after `scrollIntoViewIfNeeded`
 * on pages with `scroll-behavior: smooth` or scroll-snap, where the CDP
 * call returns immediately but the actual scroll is animated asynchronously
 * — without this wait, the next `DOM.getBoxModel` call returns the
 * pre-scroll position. Two rAFs is Playwright's pattern: the first lets
 * style/layout flush, the second ensures the scroll commit has landed.
 *
 * Best-effort: a host-side 1500 ms timeout caps the wait so a stuck rAF
 * (e.g. a fully-throttled background tab where the visibility override in
 * cdp-session didn't take effect, or a page using requestPostAnimationFrame
 * / compositor-driven timelines that remain paused) can never wedge a click.
 *
 * NB: the `timeout` field on CDP `Runtime.evaluate` does NOT exist (unlike
 * `Runtime.callFunctionOn`); Chrome silently drops it. The only real
 * timeout is the host-side `Promise.race` below — which is why a wedged
 * `awaitPromise: true` would otherwise hang forever.
 */
export async function waitForLayoutFlush(
  driver: BrowserDriver,
  tabId: TabId,
): Promise<void> {
  // Race the in-page rAF wait against a host-side timeout. Resolve normally
  // on either path — this function is documented as best-effort, and
  // proceeding with a slightly-stale layout read is strictly better than
  // wedging the click pipeline. The `try/catch` around the race still
  // catches genuine CDP errors (detach, target gone) so they don't escape.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const cdpCall = driver.sendCommand(tabId, "Runtime.evaluate", {
      expression:
        "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
      awaitPromise: true,
      returnByValue: true,
    });
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, 1500);
    });
    await Promise.race([cdpCall, timeout]);
  } catch {
    // Renderer was busy / debugger detached — don't block the click.
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Snapshot of an element's actual visual position in the page, captured in
 * a SINGLE round-trip alongside scroll and viewport size. Used both for
 * dispatch (eliminates the document↔viewport conversion race that bit
 * `tools/click-element.ts`) and for forensic logging that shows whether
 * `getBoxModel`-based coords agree with `getBoundingClientRect`.
 */
export interface ElementGeometry {
  /** Element bounding rect in VIEWPORT space (the same space CDP
   *  `Input.dispatchMouseEvent` interprets). NaN if the read failed. */
  vx: number;
  vy: number;
  vw: number;
  vh: number;
  /** Live page scroll AT THE INSTANT the rect was read. */
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  /** True iff the element resolved and the rect was read successfully. */
  ok: boolean;
  /** Free-text reason on failure. */
  error?: string;
}

/**
 * Read an element's `getBoundingClientRect()` plus scroll + viewport size in
 * a single atomic `Runtime.callFunctionOn` call. The rect is in VIEWPORT
 * coordinates by definition — no scroll subtraction needed, no race between
 * separate `getBoxModel` / `Runtime.evaluate` reads.
 *
 * Strategy: resolve the backendNodeId to a Runtime objectId, then invoke a
 * function on that object that returns the geometry as a plain JSON value.
 *
 * Returns an `{ ok: false, error: ... }` shape on any failure — callers
 * should fall back to the legacy `getBoxModel` path and log a warning.
 */
export async function readElementGeometry(
  driver: BrowserDriver,
  tabId: TabId,
  backendNodeId: number,
): Promise<ElementGeometry> {
  const empty: ElementGeometry = {
    vx: NaN,
    vy: NaN,
    vw: NaN,
    vh: NaN,
    scrollX: 0,
    scrollY: 0,
    innerWidth: 0,
    innerHeight: 0,
    ok: false,
  };
  try {
    const resolved = await driver.sendCommand<{
      object?: { objectId?: string };
    }>(tabId, "DOM.resolveNode", { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) return { ...empty, error: "DOM.resolveNode returned no objectId" };

    const result = await driver.sendCommand<{
      result?: {
        value?: {
          vx: number;
          vy: number;
          vw: number;
          vh: number;
          sx: number;
          sy: number;
          iw: number;
          ih: number;
        };
      };
    }>(tabId, "Runtime.callFunctionOn", {
      objectId,
      // Read everything in one frame: the rect is viewport-relative, scroll
      // is the live scroll at the same instant, and innerWidth/Height
      // bounds the off-viewport check.
      functionDeclaration:
        "function() { const r = this.getBoundingClientRect(); return { vx: r.x, vy: r.y, vw: r.width, vh: r.height, sx: window.scrollX, sy: window.scrollY, iw: window.innerWidth, ih: window.innerHeight }; }",
      returnByValue: true,
    });
    const v = result.result?.value;
    if (!v) return { ...empty, error: "callFunctionOn returned no value" };
    return {
      vx: v.vx,
      vy: v.vy,
      vw: v.vw,
      vh: v.vh,
      scrollX: v.sx,
      scrollY: v.sy,
      innerWidth: v.iw,
      innerHeight: v.ih,
      ok: true,
    };
  } catch (err) {
    return {
      ...empty,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

