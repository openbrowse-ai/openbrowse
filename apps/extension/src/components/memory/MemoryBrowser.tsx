// src/components/memory/MemoryBrowser.tsx
//
// File-first memory browser (Memory v2). Memory is now a folder tree of
// markdown files in OPFS, so this surfaces it the same way skills are
// surfaced: a file tree on the left, the rendered file on the right, plus a
// keyword search box wired to `memoryStore.search`.
//
// Two layouts:
//   - "sidebar" (Settings > Memory): a full-height master/detail with a
//     `w-64` secondary sidebar (header + search + scope-grouped tree) and a
//     flex-1 detail pane, matching the Skills / Connectors settings tabs.
//   - "inline" (embedded, e.g. the per-space customization rail): a compact,
//     self-contained tree + viewer that flows in normal document height.
//
// `spaceId` selects which scope's tree to show alongside the global tree:
//   - null  → global memory only (`memory/…`)
//   - "<id>" → global + that space's memory (`spaces/<id>/memory/…`)
// `showGlobal={false}` hides the global tree (used by the space rail).

import { FileViewerPanel } from "@/components/files/FileViewerPanel";
import { MemoryFileMeta } from "@/components/memory/MemoryFileMeta";
import { MemoryGraph } from "@/components/memory/MemoryGraph";
import { openSourceChat } from "@/components/memory/source-chat";
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
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SkillFileTree } from "@/entrypoints/settings/skills/SkillFileTree";
import { memoryDirPath } from "@/lib/memory/format";
import {
  memoryStore,
  type MemoryGraphData,
  type SearchResultItem,
} from "@/lib/memory/store";
import { vfsEvents } from "@/lib/vfs/events";
import { OPFS } from "@/lib/vfs/opfs";
import { Network, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Scope {
  label: string;
  /** OPFS directory root for this scope's memory. */
  base: string;
  /** Full OPFS paths of every markdown file under `base`. */
  paths: string[];
}

async function walkMemory(base: string): Promise<string[]> {
  const out: string[] = [];
  for await (const path of OPFS.walk(base)) {
    if (path.endsWith(".md")) out.push(path);
  }
  return out.sort();
}

/** Path relative to a scope root, for the tree display. */
function relTo(base: string, fullPath: string): string {
  const prefix = `${base}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

export function MemoryBrowser({
  spaceId,
  showGlobal = true,
  variant = "inline",
  onOpenFile,
  onOpenConversation,
  selectedPath,
  onSelectedPathChange,
}: {
  spaceId: string | null;
  /** Show the global memory tree alongside the space tree (default true). */
  showGlobal?: boolean;
  /** Layout: full-height secondary sidebar, or compact embedded. */
  variant?: "sidebar" | "inline";
  /**
   * When provided, the browser becomes a "picker": it renders only the
   * search box + tree and delegates opening a file to the host (which owns
   * the viewer), passing the full OPFS path. No internal detail pane. This
   * mirrors the Space Files section, whose cards open in the shared rail
   * viewer. When omitted, the browser hosts its own `FileViewerPanel`.
   */
  onOpenFile?: (fullPath: string) => void;
  /**
   * How to navigate when a `[[chat:<id>]]` source link is clicked in the
   * internal viewer. Hosts inside the home app should pass their own
   * conversation switcher so the link navigates in place; when omitted (e.g.
   * Settings, a separate entrypoint) it opens or focuses a home tab.
   */
  onOpenConversation?: (conversationId: string) => void;
  /**
   * Controlled selection. When provided (even as `null`), the host owns which
   * file the detail pane shows — Settings uses this to keep the note in the
   * URL (`?note=`). Omit it entirely for uncontrolled/local selection.
   */
  selectedPath?: string | null;
  onSelectedPathChange?: (path: string | null) => void;
}) {
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [graph, setGraph] = useState<MemoryGraphData | null>(null);
  const [results, setResults] = useState<SearchResultItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const controlled = selectedPath !== undefined;
  const selected = controlled ? selectedPath : internalSelected;
  const setSelected = useCallback(
    (path: string | null) => {
      if (!controlled) setInternalSelected(path);
      onSelectedPathChange?.(path);
    },
    [controlled, onSelectedPathChange],
  );

  const load = useCallback(async () => {
    const next: Scope[] = [];
    if (showGlobal) {
      const globalBase = memoryDirPath(null);
      next.push({
        label: "Global",
        base: globalBase,
        paths: await walkMemory(globalBase),
      });
    }
    if (spaceId) {
      const spaceBase = memoryDirPath(spaceId);
      next.push({
        label: "This space",
        base: spaceBase,
        paths: await walkMemory(spaceBase),
      });
    }
    setScopes(next);
    setLoading(false);
  }, [spaceId, showGlobal]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the tree fresh as files change (agent writes, viewer edits, deletes).
  // `vfsEvents` is bridged across extension contexts, so a run authoring
  // memory from the service worker reaches this tab too.
  //
  // The visibility pass is a catch-up: Chrome throttles and eventually freezes
  // background tabs, so a long-hidden Settings tab can miss the broadcast.
  // Re-walking on the way back to visible means the tree is never stale at the
  // moment the user actually looks at it.
  useEffect(() => {
    const onChange = () => void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    vfsEvents.addEventListener("vfs:change", onChange);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      vfsEvents.removeEventListener("vfs:change", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  // Debounced keyword search across the visible scope.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setResults(null);
      return;
    }
    debounce.current = setTimeout(async () => {
      const { results } = await memoryStore.search(query, {
        activeSpaceId: spaceId,
        limit: 20,
      });
      setResults(results);
    }, 150);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, spaceId]);

  /**
   * Drop a selection that isn't in the visible file set. This covers both a
   * stale URL-restored `?note=` (file deleted or renamed since) and
   * cross-space leakage (a link to `spaces/<other>/memory/...`): in either
   * case we fall back to the graph rather than rendering a dead viewer.
   */
  useEffect(() => {
    if (!selected || loading) return;
    if (!scopes.some((s) => s.paths.includes(selected))) setSelected(null);
  }, [selected, loading, scopes, setSelected]);

  const selectedName = useMemo(
    () => (selected ? (selected.split("/").pop() ?? selected) : null),
    [selected],
  );

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    await memoryStore.deleteById(selected);
    setSelected(null);
    await load();
  }, [selected, load]);

  // Open a file: delegate to the host in picker mode, else select it for the
  // internal detail pane.
  const openFile = useCallback(
    (fullPath: string) => {
      if (onOpenFile) onOpenFile(fullPath);
      else setSelected(fullPath);
    },
    [onOpenFile],
  );

  // Resolve a clicked [[wikilink]] to a visible file and open it.
  const handleWikiLink = useCallback(
    async (name: string) => {
      const path = await memoryStore.resolveVisiblePath(name, spaceId);
      if (path) openFile(path);
    },
    [spaceId, openFile],
  );

  // Navigate to the conversation a [[chat:<id>]] link points at.
  const handleChatLink = useCallback(
    (conversationId: string) => {
      void openSourceChat(conversationId, onOpenConversation);
    },
    [onOpenConversation],
  );

  const isEmpty = scopes.every((s) => s.paths.length === 0);

  // ── Shared subviews ──────────────────────────────────────────────────────

  const searchResultsList =
    results !== null ? (
      results.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground italic">
          No matching memory.
        </p>
      ) : (
        <div className="flex flex-col">
          {results.map((hit) => (
            <button
              key={hit.path}
              type="button"
              onClick={() => setSelected(hit.path)}
              className={`w-full text-left px-3 py-1.5 transition-colors ${
                selected === hit.path
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              }`}
            >
              <div className="text-sm font-medium truncate">{hit.title}</div>
              <div className="text-xs text-muted-foreground truncate">
                {hit.snippet || hit.description || hit.path}
              </div>
            </button>
          ))}
        </div>
      )
    ) : null;

  const scopeTrees = (
    <>
      {scopes.map((scope) =>
        scope.paths.length === 0 ? null : (
          <div key={scope.base}>
            <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground">
              {scope.label}
            </div>
            <SkillFileTree
              paths={scope.paths.map((p) => relTo(scope.base, p))}
              selectedPath={
                selected && selected.startsWith(`${scope.base}/`)
                  ? relTo(scope.base, selected)
                  : null
              }
              onSelect={(rel) => setSelected(`${scope.base}/${rel}`)}
            />
          </div>
        ),
      )}
    </>
  );

  // Delete affordance, injected into the viewer's header action row so the
  // detail pane keeps a single header instead of stacking a second bar.
  const deleteAction = selected ? (
    <AlertDialog>
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
            Delete "{selectedName}"? This removes the file and cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;

  // The graph is the detail pane's default view, so build it whenever no note
  // is selected (and refresh when the visible file set changes).
  useEffect(() => {
    if (selected !== null) return;
    let cancelled = false;
    void memoryStore.graph(spaceId).then((g) => {
      if (!cancelled) setGraph(g);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, spaceId, scopes]);

  // Parsed-frontmatter block shown above the rendered body (parity with the
  // Skills tab's description block).
  const memoryMeta = selected ? <MemoryFileMeta path={selected} /> : null;

  /** Detail-pane fallback when no note is selected: the link graph. */
  const graphPane =
    graph === null ? (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Building graph…
      </div>
    ) : graph.nodes.length === 0 ? (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
        Memory fills in as the agent learns about you and your work.
      </div>
    ) : (
      <MemoryGraph
        nodes={graph.nodes}
        edges={graph.edges}
        onOpenNode={(path) => setSelected(path)}
      />
    );

  // ── Sidebar (Settings) layout ────────────────────────────────────────────

  if (variant === "sidebar") {
    return (
      <div className="flex h-full">
        {/* Left secondary sidebar */}
        <div className="w-64 shrink-0 border-r border-border flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-sm font-medium">Memory</span>
            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setSearchOpen((v) => !v)}
                    className="p-1 rounded-md hover:bg-accent transition-colors"
                    aria-label="Search memory"
                  >
                    <Search className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Search memory</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setSelected(null)}
                    className="p-1 rounded-md hover:bg-accent transition-colors"
                    aria-label="Show memory graph"
                  >
                    <Network className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Memory graph</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {searchOpen && (
            <div className="px-3 py-2 border-b border-border">
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search memory..."
                className="w-full bg-transparent border border-border rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}

          <div className="flex-1 overflow-y-auto py-1">
            {loading ? (
              <p className="px-3 py-4 text-xs text-muted-foreground italic">
                Loading memory...
              </p>
            ) : results !== null ? (
              searchResultsList
            ) : isEmpty ? (
              <p className="px-3 py-4 text-xs text-muted-foreground italic">
                No memory yet. It fills in as the agent learns about you.
              </p>
            ) : (
              scopeTrees
            )}
          </div>
        </div>

        {/* Right detail pane */}
        <div className="flex-1 min-w-0">
          {selected ? (
            <FileViewerPanel
              key={selected}
              filePath={selected}
              fileName={selectedName ?? "memory.md"}
              spaceId={spaceId}
              openInNewTab
              showClose={false}
              headerActions={deleteAction}
              contentHeader={memoryMeta}
              onWikiLink={handleWikiLink}
              onChatLink={handleChatLink}
              onClose={() => setSelected(null)}
            />
          ) : (
            graphPane
          )}
        </div>
      </div>
    );
  }

  // ── Inline / picker (embedded) layout ────────────────────────────────────
  // In picker mode (`onOpenFile` set) we render only the search + tree and let
  // the host open the file in its own viewer (mirrors the Space Files section).
  // Otherwise we render a compact tree + an inline detail pane.

  const treeColumn = (
    <div className="rounded-md border border-border overflow-hidden">
      {scopeTrees}
    </div>
  );

  const inlineResults =
    results !== null ? (
      results.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matching memory.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {results.map((hit) => (
            <button
              key={hit.path}
              type="button"
              onClick={() => openFile(hit.path)}
              className="w-full text-left rounded-md border border-border px-3 py-2 hover:bg-accent/50 transition-colors"
            >
              <div className="text-sm font-medium truncate">{hit.title}</div>
              <div className="text-xs text-muted-foreground truncate">
                {hit.snippet || hit.description || hit.path}
              </div>
            </button>
          ))}
        </div>
      )
    ) : null;

  const searchBox = (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search memory..."
        className="pl-8 h-8 text-sm"
      />
    </div>
  );

  const emptyHint = (
    <p className="text-sm text-muted-foreground">
      No memory yet. It fills in as the agent learns about you.
    </p>
  );

  // Picker mode: search + tree only; host owns the viewer.
  if (onOpenFile) {
    return (
      <div className="flex flex-col gap-3">
        {searchBox}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading memory...</p>
        ) : results !== null ? (
          inlineResults
        ) : isEmpty ? (
          emptyHint
        ) : (
          treeColumn
        )}
      </div>
    );
  }

  // Inline detail mode: tree + an embedded viewer (fallback when no host
  // viewer is wired).
  return (
    <div className="flex flex-col gap-3">
      {searchBox}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading memory...</p>
      ) : results !== null ? (
        inlineResults
      ) : isEmpty ? (
        emptyHint
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-3">
          {treeColumn}
          <div className="min-h-50">
            {selected ? (
              <FileViewerPanel
                key={selected}
                filePath={selected}
                fileName={selectedName ?? "memory.md"}
                spaceId={spaceId}
                openInNewTab
                showClose={false}
                headerActions={deleteAction}
                contentHeader={memoryMeta}
                onWikiLink={handleWikiLink}
                onChatLink={handleChatLink}
                onClose={() => setSelected(null)}
              />
            ) : (
              <p className="text-sm text-muted-foreground px-1">
                Select a memory file to view it.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
