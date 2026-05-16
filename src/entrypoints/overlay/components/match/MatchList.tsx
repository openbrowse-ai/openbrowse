import { useEffect, useRef } from "react";
import type { Match } from "../../search/matches";
import { MatchRow } from "./MatchRow";

interface MatchListProps {
  matches: Match[];
  focusIndex: number;
  onFocusIndex: (i: number) => void;
  onAccept: (match: Match) => void;
  onClose?: (match: Match) => void;
  onToggleFavorite?: (match: Match) => void;
  onTogglePin?: (match: Match) => void;
  emptyMessage?: string;
  /** Optional hint shown at the bottom (e.g. "Searching history…"). */
  bottomHint?: string;
}

export function MatchList({
  matches,
  focusIndex,
  onFocusIndex,
  onAccept,
  onClose,
  onToggleFavorite,
  onTogglePin,
  emptyMessage,
  bottomHint,
}: MatchListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-tab-index="${focusIndex}"]`) as
      | HTMLElement
      | undefined;
    if (!el) return;
    if (!initialScrollDone.current) {
      el.scrollIntoView({ block: "center" });
      initialScrollDone.current = true;
    } else {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex]);

  if (matches.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        {emptyMessage ?? "No results."}
      </div>
    );
  }

  return (
    <div ref={listRef} className="max-h-72 overflow-y-auto overflow-x-hidden py-1">
      {matches.map((m, i) => (
        <MatchRow
          key={m.id}
          match={m}
          idx={i}
          isFocused={i === focusIndex}
          onFocusIndex={onFocusIndex}
          onAccept={onAccept}
          onClose={onClose}
          onToggleFavorite={onToggleFavorite}
          onTogglePin={onTogglePin}
        />
      ))}
      {bottomHint && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground/60 italic">{bottomHint}</div>
      )}
    </div>
  );
}
