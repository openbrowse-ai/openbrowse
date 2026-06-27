// apps/extension/src/entrypoints/_shared/components/LibraryView.tsx
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listArtifacts, deleteArtifact, setFavorite, type SavedArtifact } from "@/lib/artifacts/registry";
import { artifactsEvents } from "@/lib/artifacts/events";
import { ArrowUpRight, Trash2, Star } from "lucide-react";
import { toast } from "sonner";

export function groupArtifacts(items: SavedArtifact[]) {
  return {
    favorites: items.filter(a => a.sidecar.favorite),
    others: items.filter(a => !a.sidecar.favorite),
  };
}

export function LibraryView() {
  const [items, setItems] = useState<SavedArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<SavedArtifact | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    setLoading(true);
    setItems(await listArtifacts());
    setLoading(false);
  }
  useEffect(() => {
    void refresh();
    // Reload when any context mutates the registry (create/update/rename/
    // favorite/install/delete) so an open Library stays in sync.
    const onChange = () => void refresh();
    artifactsEvents.addEventListener("artifacts:changed", onChange);
    return () =>
      artifactsEvents.removeEventListener("artifacts:changed", onChange);
  }, []);

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteArtifact(pendingDelete.manifest.id);
      await refresh();
      setPendingDelete(null);
    } catch (err) {
      toast.error(
        `Failed to delete "${pendingDelete.manifest.title}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setDeleting(false);
    }
  }

  const { favorites, others } = groupArtifacts(items);

  const openArtifact = (a: SavedArtifact) =>
    chrome.tabs.create({ url: chrome.runtime.getURL(`artifact.html?id=${encodeURIComponent(a.manifest.id)}`) });

  const renderGrid = (list: SavedArtifact[]) => (
    <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {list.map((a) => (
        <li
          key={a.manifest.id}
          role="button"
          tabIndex={0}
          aria-label={`Open ${a.manifest.title}`}
          onClick={() => openArtifact(a)}
          onKeyDown={(e) => {
            // Ignore keys that bubbled up from a nested interactive control
            // (Favorite/Delete buttons) — otherwise Enter/Space on those would
            // both run the button action AND open the artifact.
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openArtifact(a);
            }
          }}
          className="group relative rounded-md border p-4 bg-card cursor-pointer transition-colors hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-start gap-3">
              {/* Emoji icon. Falls back to 📦 for older artifacts saved before
                  the icon field existed. The user can change the emoji from
                  the artifact's standalone tab header. */}
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-xl leading-none"
              >
                {a.manifest.icon ?? "📦"}
              </span>
              <div className="min-w-0">
                <div className="font-medium text-foreground">{a.manifest.title}</div>
                {a.manifest.description && <div className="text-xs text-muted-foreground mt-1">{a.manifest.description}</div>}
              </div>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" aria-label={a.sidecar.favorite ? "Remove from favorites" : "Add to favorites"} aria-pressed={!!a.sidecar.favorite} onClick={async (e) => {
                e.stopPropagation();
                await setFavorite(a.manifest.id, !a.sidecar.favorite);
                await refresh();
              }}>
                <Star className={`h-4 w-4 ${a.sidecar.favorite ? "fill-current text-yellow-500" : "text-muted-foreground"}`} />
              </Button>
              <Button size="sm" variant="ghost" aria-label={`Delete ${a.manifest.title}`} onClick={(e) => {
                e.stopPropagation();
                setPendingDelete(a);
              }}>
                <Trash2 className="h-4 w-4 text-foreground" />
              </Button>
            </div>
          </div>
          <div className="mt-2 pr-6 text-[11px] text-muted-foreground">
            {a.manifest.tools.length} tool(s){a.sidecar.lastOpenedAt ? ` · last opened ${new Date(a.sidecar.lastOpenedAt).toLocaleString()}` : ""}
          </div>
          <ArrowUpRight
            aria-hidden
            className="absolute bottom-2 right-2 h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          />
        </li>
      ))}
    </ul>
  );

  return (
    <main className="flex-1 min-w-0 h-screen overflow-auto p-6 bg-background">
      <h1 className="text-2xl font-semibold mb-4 text-foreground">Artifacts</h1>
      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="text-sm text-muted-foreground">
          No artifacts yet. Ask the agent to build one, e.g. <em>&quot;Make me a Linear triage dashboard.&quot;</em>
        </div>
      )}
      {favorites.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-medium mb-3 text-foreground">Favorites</h2>
          {renderGrid(favorites)}
        </div>
      )}
      {others.length > 0 && (
        <div>
          {favorites.length > 0 && <h2 className="text-lg font-medium mb-3 text-foreground">All artifacts</h2>}
          {renderGrid(others)}
        </div>
      )}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}>
        <DialogContent
          className="sm:max-w-md"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !deleting) {
              e.preventDefault();
              void confirmDelete();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete artifact?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? <>This permanently deletes <span className="font-medium text-foreground">{pendingDelete.manifest.title}</span> and its saved data. This can&apos;t be undone.</>
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? "Deleting…" : <>Delete <Kbd className="ml-1.5">⌘⏎</Kbd></>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

