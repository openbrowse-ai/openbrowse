import { useState, useEffect, useMemo } from "react";
import { OPFS } from "@/lib/vfs/opfs";
import { vfsEvents } from "@/lib/vfs/events";
import { chatDb } from "@/lib/chat-db";
import { UPLOADS_DIR } from "@/lib/uploads-dir";
import type { TodoItem } from "@/lib/types";
import {
  Folder,
  FileText,
  FileCode,
  FileImage,
  File,
  FileSpreadsheet,
  FileJson,
  FileAudio,
  FileVideo,
  Download,
  ChevronDown,
  CheckCircle2,
  Circle,
  XCircle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { downloadOpfsFile } from "@/lib/download";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface CoworkPanelProps {
  conversationId: string;
  /**
   * Click handler for a working-folder file row. Called with the file path
   * RELATIVE to the workspace root (e.g. `subdir/data.csv`). Pass `null` to
   * deselect (currently only used by the parent on Esc / file panel close).
   */
  onSelectFile: (file: string | null) => void;
}

export function CoworkPanel({ conversationId, onSelectFile }: CoworkPanelProps) {
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <ProgressCard conversationId={conversationId} />
      <WorkingFolderCard
        conversationId={conversationId}
        onSelectFile={onSelectFile}
      />
    </div>
  );
}

// ─── Reusable Card Shell ────────────────────────────────────────────────

interface CoworkCardProps {
  title: string;
  rightAdornment?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function CoworkCard({
  title,
  rightAdornment,
  defaultOpen = true,
  children,
}: CoworkCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      asChild
    >
      <section className="rounded-xl border border-border/60 bg-background shadow-sm">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-t-xl px-3.5 py-2.5 text-left hover:bg-muted/40"
          >
            <span className="text-sm font-semibold tracking-tight">{title}</span>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              {rightAdornment}
              <ChevronDown
                className={cn(
                  "size-4 transition-transform duration-200",
                  !isOpen && "-rotate-90"
                )}
              />
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <div className="px-2 pb-2">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

// ─── Progress Card (Todos) ──────────────────────────────────────────────

function ProgressCard({ conversationId }: { conversationId: string }) {
  const [todos, setTodos] = useState<TodoItem[]>([]);

  useEffect(() => {
    let isMounted = true;

    const fetchTodos = async () => {
      const conv = await chatDb.getConversation(conversationId);
      if (isMounted && conv) setTodos(conv.todos || []);
    };

    fetchTodos();
    // Poll for updates (matches old TodoPanel behavior)
    const interval = setInterval(fetchTodos, 1000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [conversationId]);

  return (
    <CoworkCard title="Progress">
      {todos.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-3.5 py-3 text-left">
          <ProgressEmptyArt />
          <p className="text-[13px] leading-snug text-muted-foreground">
            See task progress for longer tasks.
          </p>
        </div>
      ) : (
        <ul className="space-y-0.5 px-1.5 pb-1">
          {todos.map((todo) => (
            <li key={todo.id}>
              <TodoRow todo={todo} />
            </li>
          ))}
        </ul>
      )}
    </CoworkCard>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  const isCompleted = todo.status === "completed";
  const isInProgress = todo.status === "in_progress";
  const isCancelled = todo.status === "cancelled";

  return (
    <div className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
      <span className="mt-0.5 shrink-0">
        {isCompleted ? (
          <CheckCircle2
            className="size-4 fill-blue-500 text-white dark:fill-blue-400"
            strokeWidth={2.5}
          />
        ) : isInProgress ? (
          <Loader2 className="size-4 animate-spin text-blue-500 dark:text-blue-400" />
        ) : isCancelled ? (
          <XCircle className="size-4 text-muted-foreground/60" />
        ) : (
          <Circle className="size-4 text-muted-foreground/40" />
        )}
      </span>
      <span
        className={cn(
          "text-sm leading-snug",
          isCompleted && "text-muted-foreground line-through",
          isCancelled && "text-muted-foreground/60 line-through",
          isInProgress && "font-medium text-foreground",
          !isCompleted && !isInProgress && !isCancelled && "text-foreground"
        )}
      >
        {todo.content}
      </span>
    </div>
  );
}

// ─── Working Folder Card (OPFS) ─────────────────────────────────────────

function WorkingFolderCard({
  conversationId,
  onSelectFile,
}: {
  conversationId: string;
  onSelectFile: (file: string | null) => void;
}) {
  const vfsRoot = useMemo(
    () => `conversations/${conversationId}/workspace`,
    [conversationId]
  );

  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    let mounted = true;

    async function fetchFiles() {
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
      if (mounted) setFiles(paths.sort());
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
                      className="mr-1 hidden size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground group-hover:flex focus-visible:flex"
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

function FileTypeIcon({ filename }: { filename: string }) {
  const className = "size-3.5";
  if (/\.(csv|tsv|xlsx|xlsm|xls)$/i.test(filename))
    return <FileSpreadsheet className={className} />;
  if (/\.(json|jsonl|ndjson)$/i.test(filename))
    return <FileJson className={className} />;
  if (/\.(mp3|wav|ogg|flac|m4a)$/i.test(filename))
    return <FileAudio className={className} />;
  if (/\.(mp4|mov|webm|mkv)$/i.test(filename))
    return <FileVideo className={className} />;
  if (/\.(md|txt|log)$/i.test(filename)) return <FileText className={className} />;
  if (
    /\.(ts|tsx|js|jsx|html?|css|py|rs|go|java|c|cpp|sh|yml|yaml|toml|xml|sql)$/i.test(
      filename,
    )
  )
    return <FileCode className={className} />;
  if (/\.(png|jpe?g|svg|gif|webp|avif|bmp|ico)$/i.test(filename))
    return <FileImage className={className} />;
  return <File className={className} />;
}

// ─── Empty State Artwork ────────────────────────────────────────────────

function ProgressEmptyArt() {
  // A minimalist checklist: rounded rectangle with three rows;
  // first row has a small check, others remain blank.
  return (
    <svg
      width="56"
      height="48"
      viewBox="0 0 56 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-muted-foreground/40"
      aria-hidden="true"
    >
      {/* Outer card */}
      <rect
        x="4.5"
        y="4.5"
        width="47"
        height="39"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="var(--background)"
      />
      {/* Row 1: filled bullet + line + check */}
      <circle cx="13" cy="14" r="2" fill="currentColor" opacity="0.6" />
      <path
        d="M19 14H42"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M37 11.5L39 14L42 10.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-foreground/60"
      />
      {/* Row 2 */}
      <circle
        cx="13"
        cy="24"
        r="2"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M19 24H38"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.4"
      />
      {/* Row 3 */}
      <circle
        cx="13"
        cy="34"
        r="2"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M19 34H32"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}

function WorkingFolderEmptyArt() {
  // A staggered stack of two file shapes — back file peeks behind front file.
  return (
    <svg
      width="56"
      height="48"
      viewBox="0 0 56 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-muted-foreground/40"
      aria-hidden="true"
    >
      {/* Back file (offset, lighter) */}
      <path
        d="M14 6H26L32 12V36C32 37.1 31.1 38 30 38H14C12.9 38 12 37.1 12 36V8C12 6.9 12.9 6 14 6Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        opacity="0.55"
        fill="var(--background)"
      />
      <path
        d="M26 6V12H32"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        opacity="0.55"
      />
      {/* Front file */}
      <path
        d="M22 12H34L40 18V40C40 41.1 39.1 42 38 42H22C20.9 42 20 41.1 20 40V14C20 12.9 20.9 12 22 12Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        fill="var(--background)"
      />
      <path
        d="M34 12V18H40"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      {/* Content lines on front file */}
      <path
        d="M25 26H35"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.5"
      />
      <path
        d="M25 31H32"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}
