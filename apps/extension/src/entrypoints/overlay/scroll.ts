/**
 * Row-into-view scrolling that is scoped to the list it belongs to.
 *
 * `Element.scrollIntoView` walks *every* scrollable ancestor, including the
 * palette's own document. Whenever the palette was taller than the height the
 * host gave the iframe, that document could scroll — so moving the focused row
 * (or merely hovering one, since `onMouseEnter` sets `focusIndex`) dragged the
 * whole palette upward and pushed the search input off the top of the frame.
 *
 * These helpers only ever touch the nearest scrollable ancestor's `scrollTop`,
 * so nothing outside the list can move.
 */

export type RowAlign = "nearest" | "center";

/** Geometry needed to decide a new `scrollTop`, in the container's own coords. */
export interface ScrollMetrics {
  /** Current scroll offset of the container. */
  scrollTop: number;
  /** Visible height of the container. */
  clientHeight: number;
  /** Row offset from the top of the container's scrollable content. */
  rowTop: number;
  /** Row height. */
  rowHeight: number;
  /** Total scrollable content height, used to clamp the result. */
  scrollHeight: number;
}

/**
 * Pure `scrollTop` computation, split out from the DOM read so it can be tested
 * without a layout engine.
 *
 * - `nearest` scrolls the minimum amount, and nothing at all when the row is
 *   already fully visible (the common case when the pointer is driving focus).
 * - `center` centers the row, used once when the palette opens.
 */
export function nextScrollTop(
  m: ScrollMetrics,
  align: RowAlign = "nearest",
): number {
  const max = Math.max(0, m.scrollHeight - m.clientHeight);
  const clamp = (v: number) => Math.min(max, Math.max(0, v));

  if (align === "center") {
    return clamp(m.rowTop - (m.clientHeight - m.rowHeight) / 2);
  }
  if (m.rowTop < m.scrollTop) return clamp(m.rowTop);
  const rowBottom = m.rowTop + m.rowHeight;
  if (rowBottom > m.scrollTop + m.clientHeight)
    return clamp(rowBottom - m.clientHeight);
  return m.scrollTop;
}

/**
 * Nearest ancestor of `el` that actually scrolls vertically, stopping before
 * `document.body` — the document is deliberately never a candidate.
 */
export function findScrollContainer(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Reveal `el` inside its own scroll container, leaving every ancestor alone. */
export function scrollRowIntoView(
  el: HTMLElement | null | undefined,
  align: RowAlign = "nearest",
): void {
  if (!el) return;
  const container = findScrollContainer(el);
  if (!container) return;

  const containerRect = container.getBoundingClientRect();
  const rowRect = el.getBoundingClientRect();
  // Rects are viewport-relative; add the current scroll offset to get the row's
  // position within the scrollable content. Works for rows nested inside
  // section wrappers, unlike `offsetTop`.
  const rowTop = rowRect.top - containerRect.top + container.scrollTop;

  container.scrollTop = nextScrollTop(
    {
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      rowTop,
      rowHeight: rowRect.height,
      scrollHeight: container.scrollHeight,
    },
    align,
  );
}
