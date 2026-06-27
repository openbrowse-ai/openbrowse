import { useState, useEffect, useCallback } from "react";
import { Boxes, ExternalLink, Trash2 } from "lucide-react";
import {
  listArtifacts,
  deleteArtifact,
  type SavedArtifact,
} from "@/lib/artifacts/registry";
import { artifactsEvents } from "@/lib/artifacts/events";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CoworkCard } from "./cowork-card";
import { toast } from "sonner";

/**
 * Select the artifacts that originated in a given conversation. Extracted as
 * a pure function so the (conversation-scoping) rule is unit-testable without
 * rendering — the codebase tests logic, not React trees.
 */
export function artifactsForConversation(
  all: SavedArtifact[],
  conversationId: string,
): SavedArtifact[] {
  return all.filter((a) => a.sidecar.sourceConversationId === conversationId);
}

/**
 * Right-rail card listing the artifacts created by THIS conversation.
 *
 * Source of truth is the persistent artifact registry (not the transcript),
 * so it survives compaction. We filter by `sidecar.sourceConversationId`
 * and re-read whenever the registry emits `artifacts:changed` (create,
 * update, rename, favorite, install, delete).
 *
 * Hidden entirely when this conversation has no artifacts — the common case
 * — to keep the rail uncluttered.
 */
export function ArtifactsCard({
  conversationId,
  onSelectArtifact,
}: {
  conversationId: string;
  /**
   * Open an artifact in the rail's in-panel viewer. When provided, a row's
   * primary click opens the viewer; the per-row "Open as tab" button still
   * pops it out to a full browser tab. When omitted (e.g. surfaces without an
   * in-panel viewer), the primary click falls back to opening a tab.
   */
  onSelectArtifact?: (artifact: { id: string; title: string } | null) => void;
}) {
  const [items, setItems] = useState<SavedArtifact[]>([]);
  const [pendingDelete, setPendingDelete] = useState<SavedArtifact | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    let all: SavedArtifact[];
    try {
      all = await listArtifacts();
    } catch {
      return;
    }
    setItems(
      artifactsForConversation(all, conversationId),
    );
  }, [conversationId]);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    artifactsEvents.addEventListener("artifacts:changed", onChange);
    return () =>
      artifactsEvents.removeEventListener("artifacts:changed", onChange);
  }, [refresh]);

  const openTab = (a: SavedArtifact) => {
    chrome.tabs.create({
      url: chrome.runtime.getURL(
        `artifact.html?id=${encodeURIComponent(a.manifest.id)}`,
      ),
    });
  };

  // Primary row action: open in the in-panel viewer when available, else tab.
  const openArtifact = (a: SavedArtifact) => {
    if (onSelectArtifact) {
      onSelectArtifact({ id: a.manifest.id, title: a.manifest.title });
    } else {
      openTab(a);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteArtifact(pendingDelete.manifest.id);
      toast.success(`Deleted "${pendingDelete.manifest.title}"`);
      // Only dismiss the dialog on success; on failure we keep it open and
      // surface the error so the user can retry.
      setPendingDelete(null);
      // listArtifacts re-read is driven by the artifacts:changed event that
      // deleteArtifact emits; no explicit refresh needed.
    } catch (err) {
      toast.error(
        `Failed to delete "${pendingDelete.manifest.title}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setDeleting(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <>
      <CoworkCard
        title="Artifacts"
        rightAdornment={<Boxes className="size-3.5" />}
      >
        <ul className="space-y-0.5 px-1.5 pb-1">
          {items.map((a) => (
            <li key={a.manifest.id}>
              <div className="group flex items-center gap-1 rounded-md hover:bg-muted/60">
                <button
                  type="button"
                  onClick={() => openArtifact(a)}
                  className="flex flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm min-w-0"
                  aria-label={`Open ${a.manifest.title}`}
                >
                  {/* Per-artifact emoji icon. Older artifacts saved before the
                      icon field existed fall back to the generic Boxes glyph
                      so the rail still looks consistent. */}
                  {a.manifest.icon ? (
                    <span
                      aria-hidden
                      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-base leading-none"
                    >
                      {a.manifest.icon}
                    </span>
                  ) : (
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Boxes className="size-3.5" />
                    </span>
                  )}
                  <span className="truncate">{a.manifest.title}</span>
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openTab(a);
                      }}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
                      aria-label={`Open ${a.manifest.title} as a tab`}
                    >
                      <ExternalLink className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Open as tab</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete(a);
                      }}
                      className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:bg-background hover:text-destructive group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
                      aria-label={`Delete ${a.manifest.title}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Delete</TooltipContent>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      </CoworkCard>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (!deleting) void confirmDelete();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete artifact?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `"${pendingDelete.manifest.title}" and its stored data will be permanently removed. This cannot be undone.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
