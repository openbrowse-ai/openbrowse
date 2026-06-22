// src/components/memory/MemoryItem.tsx
//
// Shared memory row used in:
//   - settings.html?tab=memory (SettingsPage > MemoryTab)
//   - home spaces detail (SpacesPage > SpaceMemorySection)
//
// Both surfaces show the same row shape: title + description, a chevron
// expand toggle revealing the full content body via an animated shadcn
// Collapsible, and a destructive delete with a confirmation dialog. Keep
// this component dumb; load + delete handlers are owned by the parent
// (which knows about scope: global vs. space).

import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { type Memory } from "@/lib/memory-db";
import { Trash2, ChevronDown } from "lucide-react";

export function MemoryItem({
  memory,
  onDelete,
}: {
  memory: Memory;
  onDelete: (id: string) => void;
}) {
  return (
    <Collapsible className="border border-border rounded-md p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <CollapsibleTrigger
          className="group flex items-start gap-2 text-left flex-1 min-w-0"
        >
          <ChevronDown
            className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform duration-200 -rotate-90 group-data-[state=open]:rotate-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium truncate">
                {memory.title}
              </span>
            </div>
            {memory.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {memory.description}
              </p>
            )}
          </div>
        </CollapsibleTrigger>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete memory</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{memory.title}"? This action
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete(memory.id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <CollapsibleContent
        className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
      >
        <div className="ml-6 p-2 bg-muted rounded text-xs whitespace-pre-wrap break-words font-mono">
          {memory.content}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
