import {
  OVERLAY_HELLO_MESSAGE,
  OVERLAY_VIEWPORT_MESSAGE,
} from "@/lib/overlay-frame";
import { useEffect, useState } from "react";

/**
 * The maximum height (CSS px) the host allows the palette to occupy, or `null`
 * until the host answers.
 *
 * See `lib/overlay-frame.ts` for why this has to come from the host instead of
 * being a `vh` unit inside the iframe. While `null`, the palette lays out
 * unbounded (pre-handshake behavior) — never capped to its own viewport, which
 * would freeze the auto-size loop at the opening height.
 */
export function useHostViewport(): number | null {
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only the frame that embeds us gets to size us.
      if (e.source && e.source !== window.parent) return;
      const data = e.data as { type?: string; maxHeight?: unknown } | null;
      if (data?.type !== OVERLAY_VIEWPORT_MESSAGE) return;
      const next = data.maxHeight;
      if (typeof next !== "number" || !Number.isFinite(next) || next <= 0)
        return;
      setMaxHeight(Math.floor(next));
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: OVERLAY_HELLO_MESSAGE }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return maxHeight;
}
