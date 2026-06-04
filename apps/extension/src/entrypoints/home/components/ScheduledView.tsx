// src/entrypoints/home/components/ScheduledView.tsx
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
  Clock,
  Play,
  Pencil,
  Trash2,
  ChevronDown,
  Sparkles,
  SlidersHorizontal,
  Search,
  Info,
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
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    void taskDb.list().then((t) => setTasks(t as ScheduledTask[]));
  }, []);

  useEffect(() => {
    refresh();
    return taskDb.subscribe(refresh);
  }, [refresh]);

  // "/" focuses the search input when the user isn't already typing in a
  // field. (Escape-to-clear is handled on the input's own onKeyDown.)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.prompt.toLowerCase().includes(q),
    );
  }, [tasks, query]);

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
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Scheduled tasks</h1>
            <p className="text-sm text-muted-foreground">
              Run tasks on a schedule or whenever you need them. Type{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[0.8em]">
                /schedule
              </code>{" "}
              in any chat to set one up.
            </p>
            <p
              className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
              title="Scheduled tasks run in the background only while Chrome is open. If Chrome is closed when a task is due, that run is skipped and the next occurrence runs at its scheduled time."
            >
              <Info className="size-3.5 shrink-0" />
              Runs only while Chrome is open; missed runs are skipped.
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="shrink-0 gap-1.5">
                New task
                <ChevronDown className="size-4" />
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
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                  searchRef.current?.blur();
                }
              }}
              placeholder="Search tasks…"
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent pl-8 pr-10 py-1 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            {query ? (
              <Kbd className="absolute right-2.5 top-1/2 -translate-y-1/2">
                esc
              </Kbd>
            ) : !searchFocused ? (
              <Kbd className="absolute right-2.5 top-1/2 -translate-y-1/2">
                /
              </Kbd>
            ) : null}
          </div>
        )}

        {/* List / empty state */}
        {tasks.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Clock className="size-10" />
            <p>Create your first scheduled task</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No tasks match “{query}”.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((task) => (
              <li
                key={task.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div
                  className={cn(
                    "min-w-0 flex-1",
                    !task.enabled && "opacity-60",
                  )}
                >
                  <span className="font-medium">{task.name}</span>
                  <p className="truncate text-sm text-muted-foreground">
                    {task.description || task.prompt}
                  </p>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{formatSchedule(task.schedule)}</span>
                    {!task.enabled ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>Paused</span>
                      </>
                    ) : (
                      typeof task.nextRunAt === "number" && (
                        <>
                          <span aria-hidden>·</span>
                          <span title={new Date(task.nextRunAt).toLocaleString()}>
                            Next run {formatRelativeTime(task.nextRunAt)}
                          </span>
                        </>
                      )
                    )}
                    {task.enabled && task.lastRunStatus && (
                      <>
                        <span aria-hidden>·</span>
                        <RunStatusBadge
                          status={task.lastRunStatus}
                          error={task.lastRunError}
                        />
                      </>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Switch
                          checked={task.enabled}
                          onCheckedChange={(v) => toggle(task, v)}
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
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Open actions for ${task.name}`}
                      >
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => runNow(task)}>
                        <Play className="size-3.5" />
                        Run now
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          setEditing(task);
                          setDialogOpen(true);
                        }}
                      >
                        <Pencil className="size-3.5" />
                        Edit
                      </DropdownMenuItem>
                      {task.lastRunConversationId &&
                        (task.lastRunStatus === "success" ||
                          task.lastRunStatus === "error") && (
                          <DropdownMenuItem
                            onClick={() => openLastRun(task)}
                          >
                            <ExternalLink className="size-3.5" />
                            View last run
                          </DropdownMenuItem>
                        )}
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => remove(task)}
                      >
                        <Trash2 className="size-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            ))}
          </ul>
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
    <span
      className={cn("inline-flex items-center gap-1", config.text)}
      title={status === "error" && error ? error : undefined}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          config.dot,
          status === "running" && "animate-pulse",
        )}
      />
      {config.label}
    </span>
  );
}
