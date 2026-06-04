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
  ScrollText,
  Trash2,
  Bot,
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
import { RegistryIcon } from "@/components/ui/registry-icon";
import { getConnector } from "@openbrowse/connectors";
import { requestCloseAgentTabs } from "./request-close-agent-tabs";

interface DerivedConnector {
  id: string;
  name: string;
}

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
      <ContextCard conversationId={conversationId} onSelectFile={onSelectFile} />
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

// ─── Context Card ───────────────────────────────────────────────────────

interface ContextTab {
  id: number;
  title: string;
  favicon: string;
  /**
   * Conversation that owns this tab in `tab-scoping` (whose `ownedTabIds`
   * the tab id lives in). For tabs created by the parent agent this is
   * the parent's id; for tabs created by a subagent this is the child
   * conversation's id. Cleanup must close tabs against their owner so
   * the owner's `ownedTabIds` gets cleared (see `closeOwnedTabs`).
   */
  owningConversationId: string;
  /**
   * Set when this tab is owned by a subagent (i.e. owningConversationId
   * != parent conversationId). Used to render an indicator badge in the
   * Context card's Tabs section.
   */
  subagent?: { label: string };
}

function ContextCard({
  conversationId,
  onSelectFile,
}: {
  conversationId: string;
  onSelectFile: (file: string | null) => void;
}) {
  const uploadsRoot = useMemo(
    () => `conversations/${conversationId}/workspace/${UPLOADS_DIR}`,
    [conversationId],
  );

  const [tabs, setTabs] = useState<ContextTab[]>([]);
  const [uploads, setUploads] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<DerivedConnector[]>([]);
  const [skills, setSkills] = useState<string[]>([]);

  // Poll: tabs (from ownedTabIds) + connectors/skills (from message parts).
  useEffect(() => {
    let isMounted = true;

    async function refresh() {
      const conv = await chatDb.getConversation(conversationId);
      if (!isMounted) return;

      // Tabs — collect parent-owned tabs first, then any tabs owned by
      // subagent children (peer subagents bind their tabs to the *child*
      // conversation row in tab-scoping; incognito subagents normally
      // auto-close their ephemeral window, but if any child tabs are
      // still alive we surface them too). Each id is hydrated via
      // chrome.tabs.get; closed tabs (rejected promises) drop out.
      const children = await chatDb.listChildren(conversationId);
      if (!isMounted) return;

      type OwnedRef = {
        tabId: number;
        owningConversationId: string;
        subagent?: { label: string };
      };
      const ownedRefs: OwnedRef[] = [];
      for (const id of conv?.ownedTabIds ?? []) {
        ownedRefs.push({ tabId: id, owningConversationId: conversationId });
      }
      for (const child of children) {
        const label =
          child.subagentTraceTitle ??
          child.subagentSlug ??
          "Subagent";
        for (const id of child.ownedTabIds ?? []) {
          ownedRefs.push({
            tabId: id,
            owningConversationId: child.id,
            subagent: { label },
          });
        }
      }

      // `Promise.allSettled` preserves input order, so the resulting rows
      // keep ownedRefs order (parent tabs first, then subagent tabs).
      const results = await Promise.allSettled(
        ownedRefs.map((r) => chrome.tabs.get(r.tabId)),
      );
      if (!isMounted) return;
      const hydrated: ContextTab[] = [];
      results.forEach((res, i) => {
        if (res.status === "fulfilled") {
          const tab = res.value;
          const ref = ownedRefs[i];
          hydrated.push({
            id: ref.tabId,
            title: tab.title || tab.url || "Untitled tab",
            favicon: tab.favIconUrl ?? "",
            owningConversationId: ref.owningConversationId,
            subagent: ref.subagent,
          });
        }
      });
      if (isMounted) setTabs(hydrated);

      if (!isMounted) return;
      // Connectors + skills are recorded live onto the conversation row at
      // step-finish time (see recordToolUsageForStep in agent-transport), so
      // we read them directly from `conv` rather than scanning message parts.
      const connectorList: DerivedConnector[] = (conv?.usedConnectorIds ?? [])
        .map((id) => {
          const c = getConnector(id);
          return c ? { id: c.id, name: c.name } : null;
        })
        .filter((c): c is DerivedConnector => c !== null);
      setConnectors(connectorList);
      setSkills(conv?.loadedSkillNames ?? []);
    }

    refresh();
    const interval = setInterval(refresh, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [conversationId]);

  // Uploads: OPFS walk over `.uploads/`, refreshed on vfs:change.
  useEffect(() => {
    let mounted = true;

    async function fetchUploads() {
      const names: string[] = [];
      try {
        for await (const path of OPFS.walk(uploadsRoot)) {
          const rel = path.startsWith(uploadsRoot + "/")
            ? path.slice(uploadsRoot.length + 1)
            : path;
          if (rel) names.push(rel);
        }
      } catch {
        // No uploads dir yet.
      }
      if (mounted) setUploads(names.sort());
    }

    fetchUploads();
    const onVfsChange = (e: Event) => {
      const { path } = (e as CustomEvent).detail ?? {};
      if (typeof path === "string" && path.startsWith(uploadsRoot)) {
        fetchUploads();
      }
    };
    vfsEvents.addEventListener("vfs:change", onVfsChange);
    return () => {
      mounted = false;
      vfsEvents.removeEventListener("vfs:change", onVfsChange);
    };
  }, [uploadsRoot]);

  const isEmpty =
    tabs.length === 0 &&
    uploads.length === 0 &&
    connectors.length === 0 &&
    skills.length === 0;

  const [isCleaningTabs, setIsCleaningTabs] = useState(false);

  const handleCleanupTabs = async () => {
    if (isCleaningTabs || tabs.length === 0) return;
    setIsCleaningTabs(true);
    try {
      // Tabs owned by a subagent live in the *child* conversation's
      // `ownedTabIds`; closing them against the parent id wouldn't
      // clear the child row. Group by owning conversation id so each
      // owner's list is cleaned up correctly. `closeOwnedTabs`
      // (background) closes the tabs, clears ownership, and broadcasts
      // AGENT_TABS_CLOSED → Undo toast (handled in useAgentChat). The
      // poll loop refreshes `tabs` to [] on the next tick.
      const byOwner = new Map<string, number[]>();
      for (const t of tabs) {
        const ids = byOwner.get(t.owningConversationId) ?? [];
        ids.push(t.id);
        byOwner.set(t.owningConversationId, ids);
      }
      await Promise.all(
        Array.from(byOwner.entries()).map(([ownerId, ids]) =>
          requestCloseAgentTabs(ownerId, ids),
        ),
      );
    } finally {
      setIsCleaningTabs(false);
    }
  };

  return (
    <CoworkCard title="Context">
      {isEmpty ? (
        <div className="flex flex-col items-start gap-3 px-3.5 py-3 text-left">
          <ContextEmptyArt />
          <p className="text-[13px] leading-snug text-muted-foreground">
            Track tools and referenced files used in this task.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-1.5 pb-1">
          {tabs.length > 0 && (
            <ContextSection
              label="Tabs"
              action={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCleanupTabs}
                      disabled={isCleaningTabs}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
                      aria-label={`Clean up ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    Close {tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
                  </TooltipContent>
                </Tooltip>
              }
            >
              {tabs.map((tab) => (
                <ContextTabRow key={tab.id} tab={tab} />
              ))}
            </ContextSection>
          )}
          {uploads.length > 0 && (
            <ContextSection label="Uploads">
              {uploads.map((name) => (
                <ContextRow
                  key={name}
                  icon={<FileTypeIcon filename={name} />}
                  label={name}
                  onClick={() => onSelectFile(`${UPLOADS_DIR}/${name}`)}
                />
              ))}
            </ContextSection>
          )}
          {connectors.length > 0 && (
            <ContextSection label="Connectors">
              {connectors.map((c) => (
                <ContextRow
                  key={c.id}
                  icon={<RegistryIcon id={c.id} className="size-3.5" />}
                  label={c.name}
                />
              ))}
            </ContextSection>
          )}
          {skills.length > 0 && (
            <ContextSection label="Skills">
              {skills.map((name) => (
                <ContextRow
                  key={name}
                  icon={<ScrollText className="size-3.5" />}
                  label={name}
                />
              ))}
            </ContextSection>
          )}
        </div>
      )}
    </CoworkCard>
  );
}

function ContextSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-1 pt-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        {action}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

/** Generic display/clickable row: icon chip + truncating label. */
function ContextRow({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <li>
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted/60 min-w-0"
        >
          {inner}
        </button>
      </li>
    );
  }
  return (
    <li>
      <div className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm min-w-0">
        {inner}
      </div>
    </li>
  );
}

function ContextTabRow({ tab }: { tab: ContextTab }) {
  const focusTab = () => {
    void (async () => {
      try {
        await chrome.tabs.update(tab.id, { active: true });
        const t = await chrome.tabs.get(tab.id);
        if (typeof t.windowId === "number") {
          await chrome.windows.update(t.windowId, { focused: true });
        }
      } catch {
        // Tab gone; next poll will drop it.
      }
    })();
  };
  return (
    <li>
      <button
        type="button"
        onClick={focusTab}
        className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-muted/60 min-w-0"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {tab.favicon ? (
            <img src={tab.favicon} alt="" className="size-3.5 rounded-sm" />
          ) : (
            <span className="size-3.5 rounded-sm bg-muted-foreground/30" />
          )}
        </span>
        <span className="truncate flex-1">{tab.title}</span>
        {tab.subagent && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                aria-label={`Used by subagent: ${tab.subagent.label}`}
              >
                <Bot className="size-3" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="left">
              Used by subagent: {tab.subagent.label}
            </TooltipContent>
          </Tooltip>
        )}
      </button>
    </li>
  );
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

function ContextEmptyArt() {
  // Three small staggered rounded cards, matching the empty-state style of
  // ProgressEmptyArt / WorkingFolderEmptyArt.
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
      <rect
        x="10"
        y="10"
        width="22"
        height="22"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="var(--background)"
        opacity="0.55"
      />
      <rect
        x="18"
        y="15"
        width="22"
        height="22"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="var(--background)"
        opacity="0.75"
      />
      <rect
        x="26"
        y="20"
        width="22"
        height="22"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="var(--background)"
      />
      <path
        d="M37 28V34M34 31H40"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
