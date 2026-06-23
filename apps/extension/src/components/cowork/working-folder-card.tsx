import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Folder,
  Download,
  FileCheck,
  FileClock,
  FilePlusCorner,
} from "lucide-react";
import { OPFS } from "@/lib/vfs/opfs";
import { vfsEvents } from "@/lib/vfs/events";
import { UPLOADS_DIR } from "@/lib/uploads-dir";
import { downloadOpfsFile } from "@/lib/download";
import { saveToSpace } from "@/lib/spaces/save-to-space";
import {
  savedFilesDb,
  savedFilesEvents,
  sha256Hex,
  type SavedFile,
} from "@/lib/spaces/saved-files-db";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CoworkCard } from "./cowork-card";
import { WorkingFolderEmptyArt } from "./empty-art";
import { FileTypeIcon } from "./file-type-icon";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type RowSavedState = "unsaved" | "saved" | "stale";

export function WorkingFolderCard({
  conversationId,
  spaceId,
  onSelectFile,
  collapsible = true,
  showHeader = true,
}: {
  conversationId: string;
  /**
   * Active space id. When `null`, the per-row "Save to space" button is
   * rendered but disabled (with an explanatory tooltip).
   */
  spaceId: string | null;
  onSelectFile: (file: string | null) => void;
  collapsible?: boolean;
  showHeader?: boolean;
}) {
  const vfsRoot = useMemo(
    () => `conversations/${conversationId}/workspace`,
    [conversationId]
  );

  const [files, setFiles] = useState<string[]>([]);
  // Per-row saved-to-space state. Computed lazily — only files with a
  // saved-files-db record need a hash check; files without a record are
  // unsaved by definition. Recomputed when files change, when vfs:change
  // fires for one of our paths, or when the saved-files-db broadcasts a
  // change (e.g. another surface saved one of these files).
  const [rowState, setRowState] = useState<Record<string, RowSavedState>>({});

  useEffect(() => {
    let mounted = true;
    // Walks can overlap (initial + multiple `vfs:change` events); a stale
    // earlier walk must not clobber a newer result, so commit only the
    // latest run (monotonic token).
    let seq = 0;

    async function fetchFiles() {
      const my = ++seq;
      const paths: string[] = [];
      try {
        for await (const path of OPFS.walk(vfsRoot)) {
          // Skip user-uploaded files (kept under `.uploads/`) — the
          // Working Folder rail surfaces agent output only.
          // `OPFS.walk` may yield paths either prefixed with `vfsRoot/`
          // or already-relative; handle both.
          const rel = path.startsWith(vfsRoot + "/")
            ? path.slice(vfsRoot.length + 1)
            : path;
          if (rel.startsWith(`${UPLOADS_DIR}/`) || rel === UPLOADS_DIR) {
            continue;
          }
          paths.push(rel);
        }
      } catch {
        // Workspace doesn't exist yet
      }
      if (mounted && my === seq) setFiles(paths.sort());
    }

    fetchFiles();

    const onVfsChange = (e: Event) => {
      const { path } = (e as CustomEvent).detail ?? {};
      if (typeof path === "string" && path.startsWith(vfsRoot)) {
        fetchFiles();
      }
    };

    vfsEvents.addEventListener("vfs:change", onVfsChange);
    return () => {
      mounted = false;
      vfsEvents.removeEventListener("vfs:change", onVfsChange);
    };
  }, [vfsRoot]);

  // Compute per-row saved/stale state. Single IDB call lists every record
  // for this conversation; rows with no record are unsaved (no hash work).
  // Rows with a record need a fresh hash to compare against the recorded
  // size + hash. Skipped entirely when there's no active space (every row
  // is "unsaved" from the active scope's perspective).
  const computeRowState = useCallback(async () => {
    if (files.length === 0) {
      setRowState({});
      return;
    }
    if (!spaceId) {
      // No active space → every row is unsaved.
      const next: Record<string, RowSavedState> = {};
      for (const f of files) next[f] = "unsaved";
      setRowState(next);
      return;
    }
    let records: SavedFile[];
    try {
      records = await savedFilesDb.listForConversation(conversationId);
    } catch {
      return;
    }
    // Index records that target the active space, by filePath.
    const recordByPath = new Map<string, SavedFile>();
    for (const r of records) {
      if (r.spaceId === spaceId) recordByPath.set(r.filePath, r);
    }

    const next: Record<string, RowSavedState> = {};
    await Promise.all(
      files.map(async (rel) => {
        const record = recordByPath.get(rel);
        if (!record) {
          next[rel] = "unsaved";
          return;
        }
        // Has a record — read source bytes and compare. If reading fails
        // (file vanished mid-walk, etc.), fall back to "saved" rather than
        // misleadingly flipping to "stale" for a transient error.
        try {
          const bytes = await OPFS.readFileBytes(`${vfsRoot}/${rel}`);
          if (
            bytes.size === record.sourceSize &&
            (await sha256Hex(bytes)) === record.sourceHashHex
          ) {
            next[rel] = "saved";
          } else {
            next[rel] = "stale";
          }
        } catch {
          next[rel] = "saved";
        }
      }),
    );
    setRowState(next);
  }, [conversationId, files, spaceId, vfsRoot]);

  useEffect(() => {
    void computeRowState();
  }, [computeRowState]);

  // Re-compute when the saved-files-db is mutated by another surface
  // (e.g. the FileViewerPanel saves the same file).
  useEffect(() => {
    function onChange(e: Event) {
      const detail = (e as CustomEvent).detail ?? {};
      if (
        detail.conversationId != null &&
        detail.conversationId !== conversationId
      ) {
        return;
      }
      if (detail.spaceId != null && detail.spaceId !== spaceId) {
        return;
      }
      void computeRowState();
    }
    savedFilesEvents.addEventListener("saved-files:changed", onChange);
    return () =>
      savedFilesEvents.removeEventListener("saved-files:changed", onChange);
  }, [conversationId, spaceId, computeRowState]);

  const savingRef = useRef<Set<string>>(new Set());

  const handleSave = async (file: string) => {
    if (!spaceId) return;
    if (savingRef.current.has(file)) return;
    savingRef.current.add(file);
    try {
      const result = await saveToSpace({
        conversationId,
        spaceId,
        filePath: file,
      });
      if (result.ok) {
        toast.success(
          result.mode === "updated"
            ? `Updated "${file}" in this space`
            : `Saved "${file}" to this space`,
        );
      } else {
        toast.error(`Save failed: ${result.error}`);
      }
    } finally {
      savingRef.current.delete(file);
    }
  };

  return (
    <CoworkCard
      title="Working folder"
      rightAdornment={<Folder className="size-3.5" />}
      collapsible={collapsible}
      showHeader={showHeader}
    >
      {files.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-3.5 py-3 text-left">
          <WorkingFolderEmptyArt />
          <p className="text-[13px] leading-snug text-muted-foreground">
            View and open files created during this task.
          </p>
        </div>
      ) : (
        <ul className="space-y-0.5 px-1.5 pb-1">
          {files.map((file) => {
            const state = rowState[file] ?? "unsaved";
            return (
              <li key={file}>
                <div className="group flex items-center gap-1 rounded-md hover:bg-muted/60">
                  <button
                    type="button"
                    onClick={() => onSelectFile(file)}
                    className="flex flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm min-w-0"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <FileTypeIcon filename={file} />
                    </span>
                    <span className="truncate">{file}</span>
                  </button>
                  <SaveToSpaceRowButton
                    file={file}
                    state={state}
                    spaceActive={spaceId !== null}
                    onClick={() => void handleSave(file)}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void downloadOpfsFile(
                            `${vfsRoot}/${file}`,
                            file.split("/").pop() ?? file,
                          );
                        }}
                        className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 pointer-events-none transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
                        aria-label={`Download ${file}`}
                      >
                        <Download className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Download file</TooltipContent>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </CoworkCard>
  );
}

interface SaveToSpaceRowButtonProps {
  file: string;
  state: RowSavedState;
  spaceActive: boolean;
  onClick: () => void;
}

/**
 * Per-row save-to-space affordance. Three visual states:
 *
 *   unsaved → neutral icon, hover-revealed (matches the Download button's
 *             hover-only visibility — keeps the rail uncluttered).
 *   saved   → emerald check, *always visible* — this is the glance cue the
 *             user wants. Clicking is a no-op-ish (we still call save; the
 *             saveToSpace overwrite path is idempotent for unchanged
 *             content) and emits a friendly toast.
 *   stale   → amber clock, *always visible*. Clicking re-saves and the
 *             toast switches to "Updated" via the saveToSpace `mode`.
 *
 * Disabled (with explanatory tooltip) when no space is active. The
 * tooltip side is `top` to match the request and the Download button.
 */
function SaveToSpaceRowButton({
  file,
  state,
  spaceActive,
  onClick,
}: SaveToSpaceRowButtonProps) {
  let icon: React.ReactNode;
  let tooltip: string;
  let colorClass = "text-muted-foreground";
  // Saved/stale icons stay visible at rest; only the neutral unsaved icon
  // hides until row-hover (matches the Download button's pattern).
  let visibilityClass =
    "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto";

  if (!spaceActive) {
    icon = <FilePlusCorner className="size-3.5" />;
    tooltip = "Open this conversation in a space to enable Save to space";
  } else if (state === "saved") {
    icon = <FileCheck className="size-3.5" />;
    tooltip = "Saved to space";
    colorClass = "text-emerald-500";
    visibilityClass = "opacity-100 pointer-events-auto";
  } else if (state === "stale") {
    icon = <FileClock className="size-3.5" />;
    tooltip = "Source has changed since the last save — click to update";
    colorClass = "text-amber-500";
    visibilityClass = "opacity-100 pointer-events-auto";
  } else {
    icon = <FilePlusCorner className="size-3.5" />;
    tooltip = "Save to space";
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={!spaceActive}
          onClick={(e) => {
            e.stopPropagation();
            if (!spaceActive) return;
            onClick();
          }}
          className={cn(
            "mr-1 flex size-6 shrink-0 items-center justify-center rounded-md transition-opacity hover:bg-background hover:text-foreground disabled:hover:bg-transparent",
            colorClass,
            visibilityClass,
          )}
          aria-label={`${tooltip} (${file})`}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
