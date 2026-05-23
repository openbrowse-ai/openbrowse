import type { PanelImperativeHandle } from "react-resizable-panels";

/** Cubic ease-out — fast start, gentle landing. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

interface AnimateOptions {
  durationMs?: number;
  /** Called once per frame with the in-flight px value. */
  onTick?: (px: number) => void;
  /** Called once when the tween reaches the target (or is cancelled). */
  onDone?: (px: number) => void;
  /** Optional flag to set/clear during animation. */
  flagRef?: { current: boolean };
}

/**
 * Animate a `react-resizable-panels` panel from its current pixel width to
 * `targetPx` via requestAnimationFrame. Returns a `cancel()` function.
 *
 * The library's `resize()` is otherwise instantaneous — this wrapper exists
 * solely to give programmatic toggles (open/close, mode switch) a smooth
 * feel matching the rest of the UI.
 *
 * Caller is responsible for ensuring the panel's `minSize` allows the
 * intermediate values (e.g. minSize="0px" when collapsing). With
 * `collapsible` enabled and `collapsedSize=0`, intermediate values below
 * `minSize` would auto-collapse to 0 and break the tween — leave that flag
 * off when using this helper.
 */
export function animatePanelResize(
  handle: PanelImperativeHandle,
  fromPx: number,
  targetPx: number,
  options: AnimateOptions = {},
): () => void {
  const { durationMs = 240, onTick, onDone, flagRef } = options;
  if (Math.abs(targetPx - fromPx) < 0.5) {
    handle.resize(`${Math.round(targetPx)}px`);
    onDone?.(targetPx);
    return () => {};
  }
  const start = performance.now();
  let raf = 0;
  let cancelled = false;
  if (flagRef) flagRef.current = true;
  const step = (now: number) => {
    if (cancelled) return;
    const t = Math.min(1, (now - start) / durationMs);
    const px = fromPx + (targetPx - fromPx) * easeOutCubic(t);
    const rounded = Math.max(0, Math.round(px));
    handle.resize(`${rounded}px`);
    onTick?.(rounded);
    if (t < 1) {
      raf = requestAnimationFrame(step);
    } else {
      if (flagRef) flagRef.current = false;
      onDone?.(targetPx);
    }
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    if (flagRef) flagRef.current = false;
  };
}
