import { useEffect, useRef } from "react";
import type {
    PaletteGroup,
    PaletteIcon,
    PaletteKind,
    PaletteResult,
} from "../search/palette";
import { HighlightedText } from "./match/HighlightedText";

interface OverlayResultListProps {
  groups: PaletteGroup[];
  /**
   * Number of focusable items rendered *before* this list (e.g. the URL
   * MatchList or the zero-state tab list). Used to map the shared global
   * `focusIndex` onto this list's local rows.
   */
  focusOffset: number;
  focusIndex: number;
  onFocusIndex: (globalIndex: number) => void;
  onActivate: (result: PaletteResult) => void;
  /** Click/Tab on a group header → scope to that kind. */
  onScope?: (kind: PaletteKind) => void;
  /** Expand a group past its cap ("show N more"). */
  onExpand?: (kind: PaletteKind) => void;
  /** Render a subtle divider above the first group (below a primary list). */
  topDivider?: boolean;
}

function PaletteIconView({ icon }: { icon: PaletteIcon }) {
  if (icon.type === "favicon") {
    return icon.url ? (
      <img src={icon.url} alt="" className="size-4 shrink-0 rounded-sm" />
    ) : (
      <span className="size-4 shrink-0" />
    );
  }
  if (icon.type === "emoji") {
    return <span className="size-4 shrink-0 text-center leading-4">{icon.char}</span>;
  }
  const Comp = icon.Comp;
  return <Comp className="size-4 shrink-0" />;
}

export function OverlayResultList({
  groups,
  focusOffset,
  focusIndex,
  onFocusIndex,
  onActivate,
  onScope,
  onExpand,
  topDivider,
}: OverlayResultListProps) {
  const localFocus = focusIndex - focusOffset;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (localFocus < 0) return;
    const el = ref.current?.querySelector(
      `[data-result-index="${focusIndex}"]`,
    ) as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [focusIndex, localFocus]);

  if (groups.length === 0) return null;

  // Walk groups assigning each row its global focus index.
  let cursor = focusOffset;

  return (
    <div ref={ref} className={topDivider ? "border-t border-border" : undefined}>
      {groups.map((group) => (
        <div key={group.kind}>
          <button
            type="button"
            onClick={() => onScope?.(group.kind)}
            className="flex w-full items-center justify-between px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <span>{group.label}</span>
            {group.total > group.results.length && (
              <span className="text-muted-foreground/60">{group.total}</span>
            )}
          </button>
          {group.results.map((r) => {
            const gi = cursor++;
            const focused = gi === focusIndex;
            return (
              <div
                key={r.id}
                data-result-index={gi}
                className={`group flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors cursor-pointer ${
                  focused
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-muted"
                }`}
                onMouseEnter={() => onFocusIndex(gi)}
                onClick={() => onActivate(r)}
              >
                <PaletteIconView icon={r.icon} />
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <HighlightedText
                    text={r.title}
                    ranges={r.titleRanges ?? []}
                    className="truncate"
                  />
                  {r.subtitle && (
                    <span className="hidden md:block truncate text-xs text-muted-foreground/70">
                      {r.subtitle}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {group.hasMore && onExpand && (
            <button
              type="button"
              onClick={() => onExpand(group.kind)}
              className="px-3 py-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
            >
              Show {group.total - group.results.length} more
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
