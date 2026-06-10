import { useState } from "react";
import "./computer.css";

interface Props {
  args: Record<string, unknown>;
  result: unknown;
}

/** Anthropic computer-tool actions that represent a click (ripple-worthy). */
const CLICK_ACTIONS = new Set([
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
]);

/**
 * Renders a CUA `computer` tool result: the post-action screenshot, plus a
 * transient click ripple overlaid at the click coordinate.
 *
 * The screenshot is normalized to the model's declared display dimensions
 * (see cua/screenshot.ts), and Anthropic's `coordinate` is in that same
 * declared-pixel space — so the ripple position is `coordinate / naturalSize`
 * as a percentage of the rendered image, robust to display scaling.
 *
 * The ripple is one-shot (plays on mount, then gone) per the lightweight UI
 * choice; it is not shown when re-viewing an already-rendered trace.
 */
export function ComputerResult({ args, result }: Props) {
  const obj = result as { imageDataUrl?: string; data?: string } | undefined;
  const url = obj?.imageDataUrl ?? obj?.data;

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  if (!url) return null;

  const action = typeof args.action === "string" ? args.action : "";
  const coord = Array.isArray(args.coordinate) ? args.coordinate : null;
  // For a drag, ripple at the start point.
  const startCoord = Array.isArray(args.start_coordinate)
    ? args.start_coordinate
    : null;
  const point =
    action === "left_click_drag" ? (startCoord ?? coord) : coord;

  const showRipple =
    CLICK_ACTIONS.has(action) &&
    point != null &&
    point.length === 2 &&
    natural != null &&
    natural.w > 0 &&
    natural.h > 0;

  const leftPct = showRipple ? (Number(point![0]) / natural!.w) * 100 : 0;
  const topPct = showRipple ? (Number(point![1]) / natural!.h) * 100 : 0;

  return (
    <div className="ml-3 mt-1 pl-3 pb-1">
      <div className="relative inline-block">
        <img
          src={url}
          alt="Computer Use screenshot"
          onLoad={(e) =>
            setNatural({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          className="max-w-full h-auto max-h-[400px] rounded border border-border object-contain"
        />
        {showRipple && (
          <span
            className="cua-click-ripple"
            style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}
