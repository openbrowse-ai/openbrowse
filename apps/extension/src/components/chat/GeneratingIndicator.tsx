/**
 * Pulsing pixel-art sparkle that anchors the active assistant turn.
 *
 * Used by:
 *   - <ThinkingIndicator> (MessageList) during the post-Send / pre-stream window
 *   - <AssistantMessage> at the end of the streaming bubble
 *
 * Animation classes (`animate-scale-pulse`, `outward-core/mid/edge`) live in
 * `entrypoints/sidepanel/app.css` and `entrypoints/_shared/home.css` so the
 * indicator works on every surface that mounts a ChatView.
 */
import { useLocalModelLoadProgress } from "./useLocalModelLoadProgress";

export function GeneratingIndicator() {
  const load = useLocalModelLoadProgress();
  return (
    <div className="flex w-full items-center gap-2 pt-3">
      <svg
        viewBox="0 0 9 9"
        className="h-4 w-4 animate-scale-pulse"
        style={{ imageRendering: "pixelated" }}
        role="status"
        aria-label="Generating"
      >
        <rect x="4" y="2" width="1" height="5" fill="currentColor" className="text-blue-500 outward-core" />
        <rect x="2" y="4" width="5" height="1" fill="currentColor" className="text-blue-500 outward-core" />
        <rect x="2" y="2" width="1" height="1" fill="currentColor" className="text-blue-500 outward-mid" />
        <rect x="6" y="2" width="1" height="1" fill="currentColor" className="text-blue-500 outward-mid" />
        <rect x="2" y="6" width="1" height="1" fill="currentColor" className="text-blue-500 outward-mid" />
        <rect x="6" y="6" width="1" height="1" fill="currentColor" className="text-blue-500 outward-mid" />
        <rect x="4" y="0" width="1" height="1" fill="currentColor" className="text-blue-500 outward-edge" />
        <rect x="4" y="8" width="1" height="1" fill="currentColor" className="text-blue-500 outward-edge" />
        <rect x="0" y="4" width="1" height="1" fill="currentColor" className="text-blue-500 outward-edge" />
        <rect x="8" y="4" width="1" height="1" fill="currentColor" className="text-blue-500 outward-edge" />
      </svg>
      {load && (
        <span className="text-xs text-muted-foreground">
          Loading model… {Math.round(load.progress * 100)}%
        </span>
      )}
    </div>
  );
}
