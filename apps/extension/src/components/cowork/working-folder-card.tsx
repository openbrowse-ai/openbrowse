import { useState, useEffect, useMemo } from "react";
import { Folder, Download } from "lucide-react";
import { OPFS } from "@/lib/vfs/opfs";
import { vfsEvents } from "@/lib/vfs/events";
import { UPLOADS_DIR } from "@/lib/uploads-dir";
import { downloadOpfsFile } from "@/lib/download";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CoworkCard } from "./cowork-card";
import { WorkingFolderEmptyArt } from "./empty-art";
import { FileTypeIcon } from "./file-type-icon";

export function WorkingFolderCard({
  conversationId,
  onSelectFile,
  collapsible = true,
  showHeader = true,
}: {
  conversationId: string;
  onSelectFile: (file: string | null) => void;
  collapsible?: boolean;
  showHeader?: boolean;
}) {
  const vfsRoot = useMemo(
    () => `conversations/${conversationId}/workspace`,
    [conversationId]
  );

  const [files, setFiles] = useState<string[]>([]);

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
          {files.map((file) => (
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
                  <TooltipContent side="left">Download file</TooltipContent>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      )}
    </CoworkCard>
  );
}
