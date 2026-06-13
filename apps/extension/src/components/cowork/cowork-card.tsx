import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface CoworkCardProps {
  title: string;
  rightAdornment?: React.ReactNode;
  defaultOpen?: boolean;
  /**
   * When false, render a static (always-open) card with a plain header and
   * no expand/collapse affordance. Used when the card is already gated
   * behind another container (e.g. a side-panel popover), where a nested
   * collapsible would be redundant. Defaults to true (the home rail).
   */
  collapsible?: boolean;
  /**
   * When false (only honored in the non-collapsible variant), the title
   * header row is omitted entirely. Used by the side panel's cowork bar,
   * whose strip already labels the active panel, so the card's own
   * "Working folder" / "Context" header would be redundant.
   */
  showHeader?: boolean;
  children: React.ReactNode;
}

export function CoworkCard({
  title,
  rightAdornment,
  defaultOpen = true,
  collapsible = true,
  showHeader = true,
  children,
}: CoworkCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  if (!collapsible) {
    // No card chrome (border/shadow/rounding): the caller already provides a
    // container (e.g. a popover), so we'd otherwise nest a card in a card.
    return (
      <section>
        {showHeader && (
          <div className="flex w-full items-center justify-between px-3.5 py-2.5">
            <span className="text-sm font-semibold tracking-tight">{title}</span>
            {rightAdornment && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                {rightAdornment}
              </div>
            )}
          </div>
        )}
        <div className="px-2 pb-2">{children}</div>
      </section>
    );
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      asChild
    >
      <section className="rounded-xl border border-border/60 bg-background shadow-sm">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-t-xl px-3.5 py-2.5 text-left hover:bg-muted/40"
          >
            <span className="text-sm font-semibold tracking-tight">{title}</span>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              {rightAdornment}
              <ChevronDown
                className={cn(
                  "size-4 transition-transform duration-200",
                  !isOpen && "-rotate-90"
                )}
              />
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="px-2 pb-2">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
