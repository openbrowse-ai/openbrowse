import { useState } from "react";
import { MoreVertical, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { OPFS } from "@/lib/vfs/opfs";
import type { Space } from "@/lib/types";

/**
 * Ellipsis menu (`⋯`) attached to a Space surface (a card in the
 * Spaces list, or the active-space breadcrumb in the home sidebar).
 *
 * The menu currently exposes a single destructive action — `Delete` —
 * which routes through an `AlertDialog` confirmation. The dialog text
 * mirrors what the old `SpaceDangerSection` showed: deletion is
 * permanent, the workspace is wiped, but conversations are preserved.
 *
 * Two callsites share this so HomeSidebar and SpaceCard agree on the
 * exact prompt + side-effects (the cleanup is a fire-and-forget OPFS
 * `rm` of the space's workspace; the background handler is the
 * authoritative deleter via the `DELETE_SPACE` message).
 *
 * The trigger is provided by the caller via `children`. Callers style
 * their own button (placement, hover/focus visibility, etc.) — this
 * component only owns menu state and the confirm flow.
 */
export function SpaceActionsMenu({
  space,
  children,
  onDeleted,
  align = "end",
}: {
  space: Space;
  /** Trigger element. Will be wrapped by `DropdownMenuTrigger asChild`. */
  children: React.ReactNode;
  /** Optional callback fired after the delete message is dispatched. */
  onDeleted?: () => void;
  align?: "start" | "center" | "end";
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function doDelete() {
    chrome.runtime.sendMessage({ type: "DELETE_SPACE", spaceId: space.id });
    // Best-effort local cleanup; the background handler is authoritative.
    try {
      await OPFS.rm(`spaces/${space.id}/workspace`, { recursive: true });
    } catch {
      // Workspace may not exist yet — that's fine.
    }
    onDeleted?.();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          className="w-44"
          // Keep clicks from bubbling up to a parent click handler (e.g.
          // the SpaceCard body, which navigates on click). Without this
          // a stray click inside the menu would also "open" the card.
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem
            onClick={() => setConfirmOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete{space.name ? ` "${space.name}"` : " this space"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the space, its window binding, and
              the shared space workspace. Conversations created inside this
              space are not deleted. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => void doDelete()}
            >
              Delete space
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Default trigger button used by both HomeSidebar and SpaceCard.
 * Renders a `MoreVertical` icon with `aria-label`. The styling is
 * intentionally minimal so callers can override via `className`; the
 * exported component stays a plain `<button>` so it composes with
 * `DropdownMenuTrigger asChild`.
 */
export function SpaceActionsTrigger({
  space,
  className,
}: {
  space: Space;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Actions for space ${space.name}`}
      className={className}
    >
      <MoreVertical className="size-3.5" />
    </button>
  );
}
