import { Kbd } from "@/components/ui/kbd";
import type { Space } from "@/lib/types";
import { Check, Sparkles } from "lucide-react";
import { useState } from "react";
import type { OverlayTab } from "../OverlayApp";
import { ActionsPopover } from "./ActionsPopover";
import { LogoMenu } from "./LogoMenu";

interface OverlayFooterProps {
  actionsOpen: boolean;
  onActionsOpenChange: (open: boolean) => void;
  focusedTab: OverlayTab | null;
  isFavorited: boolean;
  showTabActions: boolean;
  enterLabel: string;
  creatingSpace: boolean;
  tidyProgress: string;
  otherSpaces: Space[];
  onAction: (action: string) => void;
  /** Activate the currently focused result (tab, chat, artifact, space, or command). */
  onEnter: () => void;
  onCreateSpace: () => void;
  onClose: () => void;
}

export function OverlayFooter({
  actionsOpen,
  onActionsOpenChange,
  focusedTab,
  isFavorited,
  showTabActions,
  enterLabel,
  creatingSpace,
  tidyProgress,
  otherSpaces,
  onAction,
  onEnter,
  onCreateSpace,
  onClose,
}: OverlayFooterProps) {
  const [logoMenuOpen, setLogoMenuOpen] = useState(false);

  return (
    <div className="relative flex items-center justify-between border-t border-border px-2 py-1.5">
      <div className="flex items-center gap-2">
        <LogoMenu open={logoMenuOpen} onOpenChange={setLogoMenuOpen} />
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
              onClick={onEnter}
              className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted transition-colors"
            >
              {enterLabel}
              <Kbd>⏎</Kbd>
            </button>
            {showTabActions && (
              <ActionsPopover
                open={actionsOpen}
                onOpenChange={onActionsOpenChange}
                tab={focusedTab}
                isFavorited={isFavorited}
                otherSpaces={otherSpaces}
                onAction={onAction}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
