import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { storage } from "@/lib/storage";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { IconPickerButton } from "@/components/spaces/SpacePickers";
import {
  SpaceActionsMenu,
  SpaceActionsTrigger,
} from "@/components/spaces/SpaceActionsMenu";
import type { Space } from "@/lib/types";

interface SpacesPageProps {
  activeSpaceId: string | null;
}

/**
 * The Spaces tab on the home page — a list of all configured spaces with
 * search, "New space", and per-card actions. There is no longer a per-space
 * detail route; configuration lives inline on the chat LandingPage when
 * the space is active. Each card's `⋯` menu offers `Delete` (and only
 * `Delete`) — the card body itself is the click-to-open target.
 */
export function SpacesPage({ activeSpaceId }: SpacesPageProps) {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Global "/" focuses the search input, and not while the user is
  // typing into another input/textarea/contentEditable (or with a
  // modifier — those are platform shortcuts).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const editable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable;
      if (editable) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const refresh = useCallback(async () => {
    const s = await storage.getSpaces();
    setSpaces(s);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refetch when spaces change in another extension context.
  useEffect(() => {
    const listener = (changes: Record<string, unknown>) => {
      if ("spaces" in changes) refresh();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [refresh]);

  const handleCreate = useCallback(
    async (name: string, icon: string | null, instructions: string | null) => {
      const next: Space = {
        id: crypto.randomUUID(),
        name,
        icon,
        windowId: null,
        position: spaces.length + 1,
        favorites: [],
        pinnedTabs: [],
        colors: null,
        colorMode: null,
        instructions,
        description: null,
        updatedAt: Date.now(),
      };
      const current = await storage.getSpaces();
      const all = [...current, next];
      await storage.setSpaces(all);
      setSpaces(all);
      // The new card appears at the top of the list. The user opens the
      // space (and lands on the chat LandingPage where the customization
      // rail lives) by clicking the card body. We deliberately don't
      // auto-activate — creating a space and switching the window
      // anchor are two distinct user intents.
    },
    [spaces],
  );

  // Sort by last-updated desc, then filter by name (case-insensitive).
  const sorted = [...spaces].sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmedQuery = query.trim().toLowerCase();
  const filtered = trimmedQuery
    ? sorted.filter((s) => s.name.toLowerCase().includes(trimmedQuery))
    : sorted;

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="px-6 py-8 max-w-5xl mx-auto w-full">
      {/* Header: title + New space button */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Spaces</h1>
        <CreateSpaceDialog onCreate={handleCreate}>
          <Button>
            <Plus className="size-4" />
            New space
          </Button>
        </CreateSpaceDialog>
      </div>

      {/* Search */}
      {spaces.length > 0 && (
        <div className="relative mb-4">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Esc clears a dirty input (and consumes the event so the
              // dialog/page Esc handlers don't also fire). When already
              // empty, let Esc propagate so it can blur or close a parent.
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search spaces..."
            className="w-full h-10 rounded-md border border-input/30 bg-muted/40 pl-9 pr-14 text-sm placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
            aria-label="Search spaces"
          />
          <Kbd className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
            {query ? "esc" : "/"}
          </Kbd>
        </div>
      )}

      {/* Empty state */}
      {spaces.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No spaces yet. Create one to get started.
          </p>
        </div>
      )}

      {/* No-search-results */}
      {spaces.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No spaces match "{query}".
        </p>
      )}

      {/* Card grid */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map((space) => (
            <SpaceCard
              key={space.id}
              space={space}
              isActive={space.id === activeSpaceId}
              onOpen={() => {
                chrome.runtime.sendMessage({
                  type: "SWITCH_SPACE",
                  spaceId: space.id,
                });
              }}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

function SpaceCard({
  space,
  isActive,
  onOpen,
}: {
  space: Space;
  isActive: boolean;
  onOpen: () => void;
}) {
  const colorPreview = space.colors
    ? space.colors.length === 1
      ? space.colors[0]
      : `linear-gradient(135deg, ${space.colors.join(", ")})`
    : undefined;
  const description = space.instructions?.trim() ?? "";
  const updatedLabel = formatRelativeUpdatedAt(space.updatedAt);

  return (
    <div className="group relative rounded-lg border border-border bg-background hover:border-foreground/30 transition-colors">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full text-left p-4 min-h-[140px] flex flex-col gap-3"
        aria-label={`Open space ${space.name}`}
      >
        <div className="flex items-center gap-2 min-w-0 pr-8">
          <span className="shrink-0 text-base leading-none" aria-hidden>
            {space.icon ?? "🪟"}
          </span>
          <span className="flex-1 truncate text-base font-semibold">
            {space.name}
          </span>
          {isActive && (
            <span
              className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              aria-label="Active in this window"
            >
              Active
            </span>
          )}
          {colorPreview && (
            <span
              className="size-3 shrink-0 rounded-full border border-border"
              style={{ background: colorPreview }}
              aria-hidden
            />
          )}
        </div>

        {description ? (
          <p className="text-sm text-muted-foreground line-clamp-3 flex-1">
            {description}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground/60 italic flex-1">
            No instructions set.
          </p>
        )}

        <p className="text-xs text-muted-foreground">Updated {updatedLabel}</p>
      </button>

      <SpaceActionsMenu space={space}>
        <SpaceActionsTrigger
          space={space}
          className="absolute top-2 right-2 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-opacity opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        />
      </SpaceActionsMenu>
    </div>
  );
}

/** Compact relative-time formatter: "just now", "5m ago", "2h ago",
 *  "3d ago", or "MMM D" / "MMM D, YYYY" for older entries. */
function formatRelativeUpdatedAt(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

/**
 * "New space" trigger that opens a dialog with the icon picker, name input,
 * and an Instructions textarea. Creation closes the dialog and the parent
 * activates the new space (via `SWITCH_SPACE`) so the user lands directly
 * inside it on the chat LandingPage — where the customization rail is
 * one scroll / one breakpoint away.
 */
function CreateSpaceDialog({
  children,
  onCreate,
}: {
  children: React.ReactNode;
  onCreate: (
    name: string,
    icon: string | null,
    instructions: string | null,
  ) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset transient form state whenever the dialog is closed (or reopened
  // after a previous create) so the next "New space" starts clean.
  useEffect(() => {
    if (!open) {
      setName("");
      setIcon(null);
      setInstructions("");
      setSubmitting(false);
    }
  }, [open]);

  const trimmed = name.trim();

  async function submit() {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const trimmedInstructions = instructions.trim();
      await onCreate(
        trimmed,
        icon,
        trimmedInstructions ? instructions : null,
      );
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        onKeyDown={(e) => {
          // ⌘↵ submits from anywhere inside the dialog (including the
          // emoji-picker popover and the instructions textarea), matching
          // the rename/delete dialogs.
          if (e.metaKey && e.key === "Enter" && trimmed && !submitting) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex items-center gap-2">
            <IconPickerButton icon={icon} onChange={setIcon} />
            <Input
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Space name"
              aria-label="Space name"
              className="flex-1 h-9"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="new-space-instructions"
              className="text-xs font-medium"
            >
              Instructions{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              Tell OpenBrowse how it should work in this space.
            </p>
            <Textarea
              id="new-space-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={5}
              placeholder="e.g. Always cite sources. Prefer markdown tables for comparisons."
              className="min-h-32 font-mono text-sm"
            />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!trimmed || submitting}
          >
            Create
            <Kbd className="ml-1.5">
              <span>⌘</span>
              <span>↵</span>
            </Kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
