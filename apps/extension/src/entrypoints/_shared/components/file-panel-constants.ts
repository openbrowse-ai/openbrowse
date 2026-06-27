/**
 * Shared sizing constants for the file-viewer panel. Used by the chat
 * `RightRail` and the space `LandingPage` so both surfaces resize the file
 * viewer with identical bounds and auto-widen behavior.
 */

/** Lower drag bound for file mode — user can't drag below this. */
export const FILE_MIN_PX = 320;
/** Soft minimum for file mode — auto-widen kicks in below this. */
export const FILE_AUTO_WIDEN_THRESHOLD_PX = 480;
/** Width used by auto-widen when the persisted width is below threshold. */
export const FILE_AUTO_WIDEN_PX = 560;
/** Animation duration for programmatic open/close and mode switches. */
export const TWEEN_MS = 240;
