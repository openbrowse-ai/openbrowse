// src/entrypoints/_shared/components/ScheduledView.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { taskDb } from "@/lib/schedule/task-db";
import { chatDb } from "@/lib/chat-db";
import { formatSchedule, formatRelativeTime } from "@/lib/schedule/format";
import type { ScheduledTask } from "@/lib/schedule/types";
import { CreateScheduledTaskDialog } from "./CreateScheduledTaskDialog";
import { cn } from "@/lib/utils";
import {
  Play,
  Pencil,
  Plus,
  Trash2,
  ChevronDown,
  Sparkles,
  SlidersHorizontal,
  Search,
  MoreVertical,
  ExternalLink,
} from "lucide-react";

interface Props {
  /** Available model strings for the create/edit dialog. */
  models: string[];
  /** Open a conversation (e.g. when clicking a run). */
  onOpenConversation: (conversationId: string) => void;
  /** Start a new chat and seed it with the /schedule slash command. */
  onCreateWithAgent: () => void;
}

export function ScheduledView({
  models,
  onOpenConversation,
  onCreateWithAgent,
}: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    void taskDb.list().then((t) => setTasks(t as ScheduledTask[]));
  }, []);

  useEffect(() => {
    refresh();
    return taskDb.subscribe(refresh);
  }, [refresh]);

  // Global "/" focuses the search input when not typing into another input
  // or with a modifier (those are platform shortcuts). Mirrors SpacesPage.
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

  // Sort by next run (soonest first), with manual/paused tasks sinking to
  // the bottom; falls back to name order so the grid is stable.
  const sorted = useMemo(() => {
    const FAR = Number.POSITIVE_INFINITY;
    return [...tasks].sort((a, b) => {
      const aNext =
        a.enabled && typeof a.nextRunAt === "number" ? a.nextRunAt : FAR;
      const bNext =
        b.enabled && typeof b.nextRunAt === "number" ? b.nextRunAt : FAR;
      if (aNext !== bNext) return aNext - bNext;
      return a.name.localeCompare(b.name);
    });
  }, [tasks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.prompt.toLowerCase().includes(q),
    );
  }, [sorted, query]);

  async function toggle(task: ScheduledTask, enabled: boolean) {
    await taskDb.update(task.id, { enabled });
  }

  function runNow(task: ScheduledTask) {
    chrome.runtime
      ?.sendMessage?.({ type: "SCHEDULER_RUN_NOW", taskId: task.id })
      ?.catch?.(() => {});
  }

  // Open the last run's conversation only if it still exists and has
  // messages. A run row can be missing (deleted) or empty (the run failed
  // before persisting anything), in which case navigating would land on a
  // blank chat — so we no-op instead.
  async function openLastRun(task: ScheduledTask) {
    const id = task.lastRunConversationId;
    if (!id) return;
    const conv = await chatDb.getConversation(id);
    if (!conv) return;
    const messages = await chatDb.getMessages(id);
    if (messages.length === 0) return;
    onOpenConversation(id);
  }

  async function remove(task: ScheduledTask) {
    await taskDb.remove(task.id);
  }

  function openManualCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="px-6 py-8 max-w-5xl mx-auto w-full">
        {/* Header: title + New task split-button */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-semibold">Scheduled tasks</h1>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="gap-1.5">
                <Plus />
                New task
                <ChevronDown className="size-4 -ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={onCreateWithAgent}>
                <Sparkles className="size-3.5 shrink-0" />
                <span className="whitespace-nowrap">Create with agent</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openManualCreate}>
                <SlidersHorizontal className="size-3.5 shrink-0" />
                <span className="whitespace-nowrap">Set up manually</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Search */}
        {tasks.length > 0 && (
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
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Search tasks..."
              className="w-full h-10 rounded-md border border-input/30 bg-muted/40 pl-9 pr-14 text-sm placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
              aria-label="Search tasks"
            />
            <Kbd className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
              {query ? "esc" : "/"}
            </Kbd>
          </div>
        )}

        {/* Empty state */}
        {tasks.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No scheduled tasks yet. Create one to get started.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Type{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]">
                /schedule
              </code>{" "}
              in any chat to set one up. Tasks run only while Chrome is open;
              missed runs are skipped.
            </p>
          </div>
        )}

        {/* No-search-results */}
        {tasks.length > 0 && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No tasks match "{query}".
          </p>
        )}

        {/* Card grid */}
        {filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {filtered.map((task) => (
              <ScheduledTaskCard
                key={task.id}
                task={task}
                onToggle={(enabled) => toggle(task, enabled)}
                onRunNow={() => runNow(task)}
                onEdit={() => {
                  setEditing(task);
                  setDialogOpen(true);
                }}
                onOpenLastRun={() => openLastRun(task)}
                onRemove={() => remove(task)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateScheduledTaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        models={models}
      />
    </div>
  );
}

function ScheduledTaskCard({
  task,
  onToggle,
  onRunNow,
  onEdit,
  onOpenLastRun,
  onRemove,
}: {
  task: ScheduledTask;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onOpenLastRun: () => void;
  onRemove: () => void;
}) {
  const description = (task.description || task.prompt || "").trim();
  const hasViewableLastRun =
    !!task.lastRunConversationId &&
    (task.lastRunStatus === "success" || task.lastRunStatus === "error");

  return (
    <div
      className={cn(
        "group relative rounded-lg border border-border bg-background hover:border-foreground/30 transition-colors",
        !task.enabled && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onEdit}
        className="block w-full text-left p-4 min-h-[140px] flex flex-col gap-3"
        aria-label={`Edit task ${task.name}`}
      >
        <div className="flex items-center gap-2 min-w-0 pr-20">
          <span className="flex-1 truncate text-base font-semibold">
            {task.name}
          </span>
          {!task.enabled && (
            <span
              className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              aria-label="Paused"
            >
              Paused
            </span>
          )}
          {task.enabled && task.lastRunStatus && (
            <RunStatusBadge
              status={task.lastRunStatus}
              error={task.lastRunError}
            />
          )}
        </div>

        {description ? (
          <p className="text-sm text-muted-foreground line-clamp-3 flex-1">
            {description}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground/60 italic flex-1">
            No description set.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          {formatSchedule(task.schedule)}
          {task.enabled && typeof task.nextRunAt === "number" && (
            <>
              {" · "}
              <span title={new Date(task.nextRunAt).toLocaleString()}>
                Next run {formatRelativeTime(task.nextRunAt)}
              </span>
            </>
          )}
        </p>
      </button>

      {/* Always-visible toggle + hover-revealed actions, mirroring
          SpaceCard's corner-affordance pattern. The toggle stays visible
          since it's a primary one-click action; the menu reveals on hover. */}
      <div className="absolute top-2 right-2 flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
              <Switch
                checked={task.enabled}
                onCheckedChange={onToggle}
                aria-label={`${task.enabled ? "Pause" : "Resume"} ${task.name}`}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {task.enabled ? "Pause" : "Resume"}
          </TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              aria-label={`Open actions for ${task.name}`}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-opacity opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <MoreVertical className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onRunNow}>
              <Play className="size-3.5" />
              Run now
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="size-3.5" />
              Edit
            </DropdownMenuItem>
            {hasViewableLastRun && (
              <DropdownMenuItem onClick={onOpenLastRun}>
                <ExternalLink className="size-3.5" />
                View last run
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function RunStatusBadge({
  status,
  error,
}: {
  status: NonNullable<ScheduledTask["lastRunStatus"]>;
  error?: string;
}) {
  const config = {
    success: { label: "Last run succeeded", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
    error: { label: "Last run failed", dot: "bg-destructive", text: "text-destructive" },
    running: { label: "Running…", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  }[status];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("shrink-0 inline-flex items-center", config.text)}
          aria-label={config.label}
        >
          <span
            className={cn(
              "size-2 rounded-full",
              config.dot,
              status === "running" && "animate-pulse",
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {status === "error" && error ? `${config.label}: ${error}` : config.label}
      </TooltipContent>
    </Tooltip>
  );
}
