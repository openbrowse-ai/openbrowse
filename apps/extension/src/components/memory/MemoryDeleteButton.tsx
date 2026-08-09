// src/components/memory/MemoryDeleteButton.tsx
//
// Confirm-and-delete affordance for a single memory note, injected into the
// file viewer's `headerActions` so the detail pane keeps one header instead of
// stacking a second bar.
//
// Shared by both surfaces that host their own viewer — Settings > Memory
// (`MemoryBrowser` variant="sidebar") and the per-space rail (`LandingPage`,
// which owns the viewer when `MemoryBrowser` runs in picker mode) — so a note
// stays deletable from whichever one opened it, with identical behavior.

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
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { memoryStore } from "@/lib/memory/store";
import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";

export function MemoryDeleteButton({
  path,
  onDeleted,
}: {
  /** Full OPFS path of the note to delete. */
  path: string;
  /**
   * Post-delete cleanup owned by the host (clear its selection, refresh its
   * tree). Called only once the file is actually gone.
   */
  onDeleted: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `memoryStore.deleteById` propagates OPFS failures, and the host can swap
  // the open note (or the active space) while a delete is in flight — a space
  // switch is a document-level hotkey, so it fires even behind the modal.
  // Tracking the live path keeps a late completion from clearing a selection
  // that has since moved on.
  const livePath = useRef(path);
  livePath.current = path;

  const name = path.split("/").pop() ?? path;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Swallow dismissals (Esc, overlay click) mid-delete so the pending
        // state — and any error it produces — stays on screen.
        if (deleting) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label="Delete memory"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Delete memory</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete memory</AlertDialogTitle>
          <AlertDialogDescription>
            Delete "{name}"? This removes the file and cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting}
            onClick={(e) => {
              // The action closes the dialog on click by default, which would
              // hide a failure and leave the note looking deleted. Hold it open
              // and close explicitly once the file is gone.
              e.preventDefault();
              setDeleting(true);
              setError(null);
              void (async () => {
                try {
                  await memoryStore.deleteById(path);
                  setOpen(false);
                  if (livePath.current === path) await onDeleted();
                } catch (err) {
                  setError(
                    `Couldn't delete this memory: ${(err as Error).message}`,
                  );
                } finally {
                  setDeleting(false);
                }
              })();
            }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
