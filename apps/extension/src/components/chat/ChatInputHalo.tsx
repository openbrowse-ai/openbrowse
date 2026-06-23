import { useMemo } from "react";
import { adjustColorsForMode, buildGradientBorder } from "@/lib/color-utils";
import type { Space } from "@/lib/types";

/**
 * Halo color used when no active space supplies its own palette —
 * i.e. windows not bound to a space, or spaces with `colors: null`.
 * A neutral light-grey (`#e5e5e5`, Tailwind `neutral-200`-ish) so the
 * focus affordance stays subtle and doesn't compete visually with
 * space-themed accent halos elsewhere.
 */
const FALLBACK_HALO_COLOR = "#e5e5e5";

interface ChatInputHaloProps {
  /**
   * Active space whose colors paint the halo. When `null`, or when the
   * space has no colors set, the halo falls back to the single-color
   * brand blue so the focus affordance is consistent across spaces and
   * non-space windows.
   */
  space: Space | null;
  /**
   * Whether to show the halo only when a focusable descendant has
   * focus (`:focus-within`) — the default — or always. Always-on is
   * useful for design previews; production callers should leave the
   * default.
   */
  alwaysOn?: boolean;
  children: React.ReactNode;
}

/**
 * Thin wrapper that paints a gradient halo around the chat composer.
 * Mirrors the visual treatment of `OverlayApp`'s outer container —
 * same gradient direction (135°), same `adjustColorsForMode`
 * pre-processing for legibility against the page background, same
 * `buildGradientBorder` helper.
 *
 * Layout-wise the halo is a separate absolutely-positioned layer
 * inset just outside the composer, so toggling its visibility doesn't
 * shift the underlying ChatInput. The halo always renders — the only
 * variation is *which* color(s) paint it. Spaces with custom colors
 * use those (gradient when 2+); spaces without colors and non-space
 * windows fall back to the brand blue.
 */
export function ChatInputHalo({
  space,
  alwaysOn = false,
  children,
}: ChatInputHaloProps) {
  const systemDark = useMemo(
    () =>
      window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
    [],
  );

  const haloGradient = useMemo(() => {
    const colors = space?.colors;
    if (colors && colors.length > 0) {
      const adjusted = adjustColorsForMode(
        colors,
        space?.colorMode ?? "auto",
        systemDark,
      );
      return buildGradientBorder(adjusted);
    }
    // No space colors → neutral light-grey halo (`#e5e5e5`). Stays
    // subtle so the focus affordance reads without competing visually
    // with the more saturated halos that appear when a space sets its
    // own colors. `buildGradientBorder` collapses a single-color list
    // to the bare value, which is what we want here.
    return buildGradientBorder([FALLBACK_HALO_COLOR]);
  }, [space?.colors, space?.colorMode, systemDark]);

  return (
    <div className="group relative w-full rounded-lg">
      {/* Gradient halo — sits in a 2.5px ring just outside the
          composer's rounded edge. `-inset-[2.5px]` extends the layer
          symmetrically; `rounded-lg` matches `ChatInput`'s own corner
          radius so the halo's outer curve hugs the composer's
          shape. The layer fades in via `group-focus-within:` so the
          halo only appears while the composer (or any of its inner
          controls) holds focus. In dark mode the saturated colors
          read as glaring against the dark background, so the layer's
          peak opacity drops to 60% to keep the focus affordance
          subtle. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute -inset-[2.5px] rounded-lg transition-opacity duration-200 ${
          alwaysOn
            ? "opacity-100 dark:opacity-60"
            : "opacity-0 group-focus-within:opacity-100 dark:group-focus-within:opacity-60"
        }`}
        style={{ background: haloGradient }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
