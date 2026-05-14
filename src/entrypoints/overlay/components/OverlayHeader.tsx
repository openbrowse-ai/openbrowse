import type { Space } from "@/lib/types";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ArrowLeft, Clock, Search, Sparkles } from "lucide-react";
import { SpacePicker } from "./SpacePicker";

interface OverlayHeaderProps {
  activeSpace: Space | null;
  spaces: Space[];
  query: string;
  onQueryChange: (q: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSwitchSpace: (spaceId: string) => void;
  isActionMode: boolean;
  creatingSpace?: boolean;
  configuringSpace?: boolean;
  editingColor?: boolean;
  onBack?: () => void;
  historyMode?: boolean;
  onExitHistory?: () => void;
  onConfigureSpace?: () => void;
  onOpenChat?: () => void;
}

export function OverlayHeader({
  activeSpace,
  spaces,
  query,
  onQueryChange,
  inputRef,
  onSwitchSpace,
  isActionMode,
  creatingSpace,
  configuringSpace,
  editingColor,
  onBack,
  historyMode,
  onExitHistory,
  onConfigureSpace,
  onOpenChat,
}: OverlayHeaderProps) {
  if (creatingSpace) {
    return (
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <button
          onClick={onBack}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="text-sm text-muted-foreground">New space</span>
      </div>
    );
  }

  if (configuringSpace || editingColor) {
    return (
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <button
          onClick={onBack}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="text-sm text-muted-foreground">
          {editingColor
            ? `Theme color for ${activeSpace?.icon ? activeSpace.icon + " " : ""}${activeSpace?.name ?? "space"}`
            : "Configure space"}
        </span>
      </div>
    );
  }

  const placeholder = isActionMode
    ? "Search commands..."
    : historyMode
      ? "Search history..."
      : "Search tabs...  / for commands";

  return (
    <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
      {historyMode ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onExitHistory}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Back <Kbd>esc</Kbd></TooltipContent>
        </Tooltip>
      ) : (
        <SpacePicker
          activeSpace={activeSpace}
          spaces={spaces}
          onSwitchSpace={onSwitchSpace}
          onConfigureSpace={onConfigureSpace}
        />
      )}
      <div className="flex flex-1 items-center gap-1.5">
        {isActionMode ? (
          <p className="shrink-0 text-muted-foreground">/</p>
        ) : historyMode ? (
          <Clock className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              e.stopPropagation();
              onQueryChange("");
            }
          }}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {query ? (
          <button
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
            className="shrink-0"
          >
            <Kbd className="cursor-pointer hover:bg-muted/80">esc</Kbd>
          </button>
        ) : !isActionMode && !historyMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onOpenChat}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <Sparkles className="size-3" />
                <Kbd>⌥I</Kbd>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle agent panel</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
