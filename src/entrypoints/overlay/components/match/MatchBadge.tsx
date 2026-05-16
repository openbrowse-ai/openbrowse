import { Bookmark, Clock, Heart, History, Pin } from "lucide-react";
import type { Match, MatchSource } from "../../search/matches";

interface MatchBadgeProps {
  match: Match;
}

interface BadgeSpec {
  label: string;
  icon: typeof Bookmark | null;
  emoji?: string;
}

function specForSource(source: MatchSource, match: Match): BadgeSpec | null {
  switch (source) {
    case "tab":
      if (match.active) return { label: "Current tab", icon: null };
      if (match.pinned) return { label: "Pinned", icon: Pin };
      return { label: "Switch to tab", icon: null };
    case "tab-other-space":
      return {
        label: match.spaceName ? `Switch to ${match.spaceName}` : "Other space",
        icon: null,
        emoji: match.spaceIcon,
      };
    case "favorite-open":
      return { label: "Favorited", icon: Heart };
    case "favorite-closed":
      return { label: "Favorite", icon: Heart };
    case "bookmark":
      return { label: "Bookmark", icon: Bookmark };
    case "closed":
      return { label: "Recently closed", icon: Clock };
    case "history":
      return { label: "History", icon: History };
  }
}

export function MatchBadge({ match }: MatchBadgeProps) {
  const primary = specForSource(match.source, match);
  if (!primary) return null;

  const PrimaryIcon = primary.icon;

  return (
    <div className="flex items-center gap-1 shrink-0">
      <span className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground bg-muted">
        {primary.emoji && <span>{primary.emoji}</span>}
        {PrimaryIcon && <PrimaryIcon className="size-2.5" />}
        <span>{primary.label}</span>
      </span>
      {match.sectionName && match.source === "tab" && (
        <span className="rounded px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground bg-muted">
          {match.sectionName}
        </span>
      )}
    </div>
  );
}
