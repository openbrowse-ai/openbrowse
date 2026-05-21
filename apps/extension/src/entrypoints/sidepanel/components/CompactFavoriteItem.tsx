import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { FavoriteTabAssociation } from "@/lib/types";
import { Kbd } from "@/components/ui/kbd";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";

interface CompactFavoriteItemProps {
  tabId: string;
  url: string;
  title?: string;
  isFocused: boolean;
  isSelected: boolean;
  selectionActive: boolean;
  isActive?: boolean;
  association?: FavoriteTabAssociation;
  onOpen: (url: string, source?: string) => void;
  onRemove: (url: string) => void;
}

export function CompactFavoriteItem({
  tabId,
  url,
  title,
  isFocused,
  isSelected,
  selectionActive,
  isActive,
  association,
  onOpen,
  onRemove,
}: CompactFavoriteItemProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`;
  const hasNavigatedAway = !!(association && association.currentUrl !== association.favoriteUrl);

  useEffect(() => {
    if (isFocused && rowRef.current) {
      rowRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [isFocused]);

  async function handleBackToFavorite() {
    if (association) {
      await chrome.tabs.update(association.tabId, { url: association.favoriteUrl });
    }
  }

  return (
    <div
      ref={rowRef}
      data-tab-id={tabId}
      data-tab-type="favorite"
      className={`group flex items-center gap-2 px-2 h-[30px] rounded-sm transition-colors cursor-default ${
        isSelected && isFocused
          ? "bg-blue-200/60 dark:bg-blue-900/40 ring-2 ring-blue-400 dark:ring-blue-600"
          : isSelected
            ? "bg-blue-100/60 dark:bg-blue-900/30 ring-1 ring-blue-300 dark:ring-blue-700"
            : isFocused
              ? "bg-[var(--accent)] ring-1 ring-[var(--ring)]"
              : "hover:bg-[var(--muted)]"
      }`}
    >
      {selectionActive && (
        <div className={`w-3.5 h-3.5 shrink-0 rounded-sm border flex items-center justify-center text-[10px] ${
          isSelected
            ? "bg-[var(--primary)] border-[var(--primary)] text-[var(--primary-foreground)]"
            : "border-[var(--border)]"
        }`}>
          {isSelected && "✓"}
        </div>
      )}
      {hasNavigatedAway ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleBackToFavorite}
              className="w-4 h-4 shrink-0 flex items-center justify-center rounded hover:bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <ArrowLeft className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Back to {new URL(url).hostname}</TooltipContent>
        </Tooltip>
      ) : (
        <img src={faviconUrl} alt="" className="w-4 h-4 shrink-0" />
      )}
      {isActive && (
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
      )}
      {hasNavigatedAway && (
        <span className="text-[var(--muted-foreground)] text-[10px] shrink-0">/</span>
      )}
      <button
        onClick={() => onOpen(url, "favorite")}
        className="flex-1 min-w-0 text-xs font-mono truncate text-left text-[var(--foreground)] hover:text-blue-600 transition-colors"
        title={hasNavigatedAway ? `${association!.currentTitle}\n${association!.currentUrl}` : `${title ?? url}\n${url}`}
      >
        {hasNavigatedAway ? association!.currentTitle : (title ?? url)}
      </button>
      <div className={`flex items-center gap-0 shrink-0 transition-opacity ${
        isFocused ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      }`}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onOpen(url, "favorite")}
              className="h-5 w-5 flex items-center justify-center rounded-sm hover:bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="flex items-center gap-1.5 text-xs">
              Open
              <Kbd>↵</Kbd>
            </span>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onRemove(url)}
              className="h-5 w-5 flex items-center justify-center rounded-sm hover:bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
            >
              <X className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span className="flex items-center gap-1.5 text-xs">
              Unpin
              <Kbd>⌫</Kbd>
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
