// src/entrypoints/settings/memory-sync/MemorySyncButton.tsx
//
// The memory-sync affordance: an icon in the Memory header that opens the sync
// panel in a popover.
//
// It lives in the header rather than as a block above the tree because the
// Memory tab is a full-height master/detail. A stacked section shortens both the
// file tree and the note viewer permanently, to pay for a control that is touched
// about twice per profile and then only when something needs reconnecting.
//
// The icon carries state so the popover doesn't have to be open to notice a
// problem: an amber dot means sync needs a click (a lapsed grant, a moved
// folder, a denied permission), and unresolved conflicts get one too.

import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMemorySync } from "@/hooks/useMemorySync";
import { FolderSync } from "lucide-react";
import { useState } from "react";
import { MemorySyncSection } from "./MemorySyncSection";

export function MemorySyncButton() {
  const [open, setOpen] = useState(false);
  // One hook instance, shared with the panel: calling `useMemorySync()` in both
  // would install two sets of triggers and race two sync passes.
  const sync = useMemorySync();

  const needsAttention =
    sync.status === "lapsed" ||
    sync.status === "missing" ||
    sync.status === "denied" ||
    sync.conflicts.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className="relative p-1 rounded-md hover:bg-accent transition-colors"
              aria-label={tooltipFor(sync.status, sync.conflicts.length)}
            >
              <FolderSync
                className={
                  sync.status === "granted"
                    ? "h-4 w-4"
                    : "h-4 w-4 text-muted-foreground"
                }
              />
              {needsAttention && (
                <span
                  aria-hidden
                  className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-amber-500"
                />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {tooltipFor(sync.status, sync.conflicts.length)}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-96 p-4">
        <MemorySyncSection sync={sync} />
      </PopoverContent>
    </Popover>
  );
}

function tooltipFor(
  status: ReturnType<typeof useMemorySync>["status"],
  conflicts: number,
): string {
  if (conflicts > 0) {
    return conflicts === 1 ? "Memory sync — 1 conflict" : `Memory sync — ${conflicts} conflicts`;
  }
  switch (status) {
    case "unset":
      return "Sync memory across profiles";
    case "lapsed":
      return "Memory sync — reconnect the folder";
    case "missing":
      return "Memory sync — folder not found";
    case "denied":
      return "Memory sync — access denied";
    case "granted":
      return "Memory sync";
  }
}
