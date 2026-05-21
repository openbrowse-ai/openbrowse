import { Kbd } from "@/components/ui/kbd";
import type { OverlayTab } from "../OverlayApp";
import type { Space } from "@/lib/types";
import { ActionsPopover } from "./ActionsPopover";
import { LogoMenu } from "./LogoMenu";
import { Check, Sparkles } from "lucide-react";
import { useRef, useState } from "react";

interface OverlayFooterProps {
  actionsOpen: boolean;
  onActionsOpenChange: (open: boolean) => void;
  actionsButtonRef: React.RefObject<HTMLButtonElement | null>;
  focusedTab: OverlayTab | null;
  isFavorited: boolean;
  isActionMode: boolean;
  creatingSpace: boolean;
  tidyProgress: string;
  otherSpaces: Space[];
  onAction: (action: string) => void;
  onCreateSpace: () => void;
  onClose: () => void;
}

export function OverlayFooter({
  actionsOpen,
  onActionsOpenChange,
  actionsButtonRef,
  focusedTab,
  isFavorited,
  isActionMode,
  creatingSpace,
  tidyProgress,
  otherSpaces,
  onAction,
  onCreateSpace,
  onClose,
}: OverlayFooterProps) {
  const [logoMenuOpen, setLogoMenuOpen] = useState(false);
  const logoButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="relative flex items-center justify-between border-t border-border px-2 py-1.5">
      <div className="flex items-center gap-2">
        <button
          ref={logoButtonRef}
          onClick={() => setLogoMenuOpen((o) => !o)}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="Menu"
        >
          <img src={chrome.runtime.getURL("/icon/32.png")} alt="OpenBrowse" className="size-4" />
        </button>
        <LogoMenu open={logoMenuOpen} onOpenChange={setLogoMenuOpen} anchorRef={logoButtonRef} />
        {tidyProgress === "done" ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="size-3" />
            Tidied
          </span>
        ) : tidyProgress ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground animate-pulse">
            <Sparkles className="size-3" />
            Tidying {tidyProgress}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
            <Kbd className="h-4 min-w-4 text-[10px]">↑</Kbd>
            <Kbd className="h-4 min-w-4 text-[10px]">↓</Kbd>
            to navigate
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {creatingSpace ? (
          <button
            onClick={onCreateSpace}
            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted transition-colors"
          >
            Create
            <Kbd>⌘⏎</Kbd>
          </button>
        ) : (
          <>
            <button
              onClick={() => focusedTab && onAction("open")}
              className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted transition-colors"
            >
              {isActionMode ? "Run command" : "Open tab"}
              <Kbd>⏎</Kbd>
            </button>
            {!isActionMode && (
              <button
                ref={actionsButtonRef}
                onPointerDown={(e) => {
                  if (actionsOpen) {
                    e.preventDefault();
                    onActionsOpenChange(false);
                  }
                }}
                onClick={() => { if (!actionsOpen) onActionsOpenChange(true); }}
                className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted transition-colors"
              >
                Actions
                <Kbd>⌘K</Kbd>
              </button>
            )}
          </>
        )}
      </div>
      <ActionsPopover
        open={actionsOpen}
        onOpenChange={onActionsOpenChange}
        anchorRef={actionsButtonRef}
        tab={focusedTab}
        isFavorited={isFavorited}
        otherSpaces={otherSpaces}
        onAction={onAction}
      />
    </div>
  );
}
