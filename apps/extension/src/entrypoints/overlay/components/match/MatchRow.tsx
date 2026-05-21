import { useEffect, useRef, useState } from "react";
import { Heart, Pin, RotateCcw, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Match } from "../../search/matches";
import { HighlightedText } from "./HighlightedText";
import { MatchBadge } from "./MatchBadge";

function faviconUrl(pageUrl: string, favicon: string): string {
  if (favicon) return favicon;
  try {
    const hostname = new URL(pageUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return "";
  }
}

function compactUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname === "/" ? "" : u.pathname;
    return host + path + u.search;
  } catch {
    return url;
  }
}

/**
 * Adjust title ranges from full URL onto compact URL string. If we can't
 * realign cleanly, return [] so we just show the compact URL plain.
 */
function adjustUrlRanges(fullUrl: string, compact: string, ranges: Match["urlRanges"]): Match["urlRanges"] {
  if (!ranges.length) return [];
  // Try to align: find compact inside fullUrl (e.g. fullUrl might have "https://www." prefix)
  const lowerFull = fullUrl.toLowerCase();
  const lowerCompact = compact.toLowerCase();
  // Approach: find the offset where compact starts in fullUrl by lining up the host.
  // Simpler: for each range, slice fullUrl, then find that slice in compact.
  const out: Match["urlRanges"] = [];
  for (const [start, end] of ranges) {
    const slice = lowerFull.slice(start, end);
    if (!slice) continue;
    const idx = lowerCompact.indexOf(slice);
    if (idx >= 0) out.push([idx, idx + slice.length]);
  }
  return out;
}

interface MatchRowProps {
  match: Match;
  idx: number;
  isFocused: boolean;
  onFocusIndex: (i: number) => void;
  onAccept: (match: Match) => void;
  onClose?: (match: Match) => void;
  onToggleFavorite?: (match: Match) => void;
  onTogglePin?: (match: Match) => void;
}

export function MatchRow({
  match,
  idx,
  isFocused,
  onFocusIndex,
  onAccept,
  onClose,
  onToggleFavorite,
  onTogglePin,
}: MatchRowProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isFocused) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isFocused]);

  const isTabLike =
    match.source === "tab" ||
    match.source === "tab-other-space" ||
    match.source === "favorite-open";
  const compact = compactUrl(match.url);
  const adjustedUrlRanges = adjustUrlRanges(match.url, compact, match.urlRanges);
  const faviconSrc = faviconUrl(match.url, match.favicon);
  const [faviconFailed, setFaviconFailed] = useState(false);

  // Reset failure flag when the favicon URL changes (e.g. row reused for a different match).
  useEffect(() => {
    setFaviconFailed(false);
  }, [faviconSrc]);

  return (
    <div
      ref={ref}
      data-tab-index={idx}
      className={`group flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors cursor-pointer ${
        isFocused ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-muted"
      }`}
      onClick={() => onFocusIndex(idx)}
      onDoubleClick={() => onAccept(match)}
    >
      {faviconFailed ? (
        <span className="size-4 shrink-0" />
      ) : (
        <img
          src={faviconSrc}
          alt=""
          className="size-4 shrink-0 rounded-sm"
          onError={() => setFaviconFailed(true)}
        />
      )}
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <HighlightedText
          text={match.title || compact}
          ranges={match.titleRanges}
          className="truncate"
        />
        <HighlightedText
          text={compact}
          ranges={adjustedUrlRanges}
          className="hidden md:block truncate text-xs text-muted-foreground/70"
        />
      </div>
      <MatchBadge match={match} />
      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
        {isTabLike ? (
          <>
            {onTogglePin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(match);
                    }}
                  >
                    <Pin className="size-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{match.pinned ? "Unpin" : "Pin"}</TooltipContent>
              </Tooltip>
            )}
            {onToggleFavorite && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(match);
                    }}
                  >
                    <Heart
                      className={`size-3 ${match.source === "favorite-open" || match.source === "favorite-closed" ? "fill-current" : ""}`}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {match.source === "favorite-open" || match.source === "favorite-closed"
                    ? "Unfavorite"
                    : "Favorite"}
                </TooltipContent>
              </Tooltip>
            )}
            {onClose && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-destructive hover:bg-muted"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(match);
                    }}
                  >
                    <X className="size-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">Close tab</TooltipContent>
              </Tooltip>
            )}
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  onAccept(match);
                }}
              >
                <RotateCcw className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {match.action === "restore" ? "Restore tab" : "Open"}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
