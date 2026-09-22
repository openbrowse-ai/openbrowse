/**
 * Sizing contract between the command palette (an iframe served from the
 * extension origin) and whatever hosts it: the page content script, `HomeApp`,
 * and the `useOverlay` hook.
 *
 * The palette shrink-wraps its content — it measures itself and posts
 * `OPENBROWSE_OVERLAY_RESIZE`, and the host applies that as the iframe's
 * height. The *ceiling* is the host's call: the iframe may never grow past
 * `OVERLAY_MAX_HEIGHT_RATIO` of the host viewport.
 *
 * The palette can't derive that ceiling on its own:
 *
 * - On a web page the host is a different origin, so `parent.innerHeight` is
 *   unreadable.
 * - `100vh` *inside* the iframe means "the height the host already gave us",
 *   so capping to it deadlocks the auto-size loop at whatever height the
 *   palette opened with (type a query, get more results, stay clipped).
 *
 * So the host posts the budget in CSS px and the palette caps its root at that
 * value, shrinking its scroll regions so the search input and footer stay
 * inside the frame. Without this, the host's `max-height` silently clipped a
 * taller-than-budget palette and the iframe document itself scrolled — which
 * is how the search input ended up scrolled out of view.
 */

/** Host → palette: the palette may not exceed `maxHeight` CSS px. */
export const OVERLAY_VIEWPORT_MESSAGE = "OPENBROWSE_OVERLAY_VIEWPORT";

/**
 * Palette → host: "my listener is attached, send the budget". The host also
 * posts unprompted (on iframe load, on host resize), but that can land before
 * React has mounted, so the palette asks as well.
 */
export const OVERLAY_HELLO_MESSAGE = "OPENBROWSE_OVERLAY_HELLO";

/**
 * Fraction of the host viewport the palette may occupy. Mirrored by the
 * `max-height` on the iframe in every host (kept as a belt-and-braces clamp
 * for the brief window before the handshake completes).
 */
export const OVERLAY_MAX_HEIGHT_RATIO = 0.7;

/**
 * `floor`, not `round`, so the budget can never land a pixel *above* the
 * hosts' `max-height: 70vh` and get clipped by it.
 */
export function overlayMaxHeight(viewportHeight: number): number {
  return Math.max(0, Math.floor(viewportHeight * OVERLAY_MAX_HEIGHT_RATIO));
}

/** Send the current budget to an overlay iframe. No-op if it isn't mounted. */
export function postOverlayViewport(
  iframe: HTMLIFrameElement | null | undefined,
): void {
  iframe?.contentWindow?.postMessage(
    {
      type: OVERLAY_VIEWPORT_MESSAGE,
      maxHeight: overlayMaxHeight(window.innerHeight),
    },
    "*",
  );
}

/**
 * Post the budget now and on every host resize. `getIframe` is re-read each
 * time so a single long-lived listener can serve overlays that mount and
 * unmount (the page content script keeps one for the tab's lifetime).
 *
 * Returns a teardown for the resize listener.
 */
export function watchOverlayViewport(
  getIframe: () => HTMLIFrameElement | null | undefined,
): () => void {
  const post = () => postOverlayViewport(getIframe());
  post();
  window.addEventListener("resize", post);
  return () => window.removeEventListener("resize", post);
}

/**
 * Host-side half of the handshake: answer a palette's HELLO with the budget.
 * Returns whether the message was ours, so callers can keep their `if` chains
 * flat.
 */
export function handleOverlayHello(
  event: MessageEvent,
  iframe: HTMLIFrameElement | null | undefined,
): boolean {
  if ((event.data as { type?: string } | null)?.type !== OVERLAY_HELLO_MESSAGE)
    return false;
  postOverlayViewport(iframe);
  return true;
}
