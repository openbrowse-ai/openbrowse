import { useCallback, useEffect, useState } from "react";
import { openOrFocusConversation } from "./open-conversation";

export interface ActiveTaskSummary {
  taskId: string;
  hostName: string;
  prompt: string;
  /**
   * Chat-db conversation id, or null during the brief window between
   * `tasksStore.register` and the runner calling
   * `updateConversationId`. While null, the card renders
   * non-clickable — there's no destination yet.
   */
  conversationId: string | null;
  targetWindowId: number;
  spaceId: string | null;
  startedAt: number;
  taskTitlePreview: string | null;
  /** Best-effort URL the agent is currently working on. Null if not known. */
  currentUrl: string | null;
  /** Short hint of last progress event. Null if none yet. */
  lastEvent: string | null;
}

export interface ActiveTaskCardProps {
  task: ActiveTaskSummary;
  onCancelled: () => void;
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Pure helper, exported for unit testing: builds the cancel-message
 * payload.
 */
export function buildCancelMessage(taskId: string): {
  type: "MCP_BRIDGE_CANCEL_TASK";
  taskId: string;
} {
  return { type: "MCP_BRIDGE_CANCEL_TASK", taskId };
}

/**
 * Pure helper, exported for unit testing: formats the "Xs / Xm / Xh"
 * elapsed-time caption. Threshold rollovers at 60s and 3600s.
 */
export function formatElapsed(startedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}

/**
 * Pure helper, exported for unit testing: prefer the agent-derived
 * `taskTitlePreview` (which has been title-cased and trimmed) over
 * the raw prompt. Falls back to the prompt when no preview is
 * available.
 */
export function pickDisplayTitle(task: ActiveTaskSummary): string {
  return task.taskTitlePreview ?? task.prompt;
}

/**
 * Pure helper, exported for unit testing: normalises the
 * progress-line inputs. Empty strings collapse to null so the
 * renderer can use simple null-checks.
 */
export function pickProgressLine({
  currentUrl,
  lastEvent,
}: {
  currentUrl: string | null;
  lastEvent: string | null;
}): { url: string | null; event: string | null } {
  return {
    url: currentUrl && currentUrl.length > 0 ? currentUrl : null,
    event: lastEvent && lastEvent.length > 0 ? lastEvent : null,
  };
}

/**
 * Pure helper, exported for unit testing: returns whether a card
 * with this conversationId should be clickable. The conversationId
 * is `null` during the brief window between dispatch and the runner
 * patching it via `tasksStore.updateConversationId`. Whitespace-only
 * strings are also rejected as a defensive measure (chat-db ids are
 * UUIDs, so this should never trigger in production).
 */
export function canOpenConversation(conversationId: string | null): boolean {
  return conversationId !== null && conversationId.trim().length > 0;
}

export function ActiveTaskCard({
  task,
  onCancelled,
  now = Date.now,
}: ActiveTaskCardProps) {
  const [busy, setBusy] = useState(false);

  // Tick the elapsed caption once a second so it stays current
  // without the parent having to re-render on a timer.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const clickable = canOpenConversation(task.conversationId);

  const handleOpen = useCallback(() => {
    if (!clickable || task.conversationId == null) return;
    void openOrFocusConversation(task.conversationId);
  }, [clickable, task.conversationId]);

  const handleStop = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await chrome.runtime.sendMessage(buildCancelMessage(task.taskId));
      onCancelled();
    } finally {
      setBusy(false);
    }
  }, [busy, task.taskId, onCancelled]);

  const elapsed = formatElapsed(task.startedAt, now());
  const title = pickDisplayTitle(task);
  const progress = pickProgressLine({
    currentUrl: task.currentUrl,
    lastEvent: task.lastEvent,
  });

  // A11y (C1 fix): the clickable surface and the Stop button are now
  // siblings (not nested), so each is a proper <button> with native
  // focus semantics. The outer is a flex container (NOT interactive)
  // that just lays them out side-by-side.
  return (
    <div className="flex w-full items-start justify-between gap-3 rounded border border-border p-3">
      {clickable ? (
        <button
          type="button"
          onClick={handleOpen}
          className="-m-3 flex-1 cursor-pointer rounded-l p-3 text-left hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CardBody
            hostName={task.hostName}
            elapsed={elapsed}
            title={title}
            progress={progress}
          />
        </button>
      ) : (
        <div className="flex-1">
          <CardBody
            hostName={task.hostName}
            elapsed={elapsed}
            title={title}
            progress={progress}
          />
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={handleStop}
        className="rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        Stop
      </button>
    </div>
  );
}

/**
 * Internal — the card's metadata + title + progress lines. Extracted
 * so the clickable + non-clickable branches don't duplicate JSX.
 */
function CardBody({
  hostName,
  elapsed,
  title,
  progress,
}: {
  hostName: string;
  elapsed: string;
  title: string;
  progress: { url: string | null; event: string | null };
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
          {hostName}
        </span>
        <span className="text-muted-foreground">Running · {elapsed}</span>
      </div>
      <div className="mt-1 truncate text-sm">{title}</div>
      {(progress.url || progress.event) && (
        <div className="mt-1 space-y-0.5">
          {progress.url && (
            <div
              className="truncate text-xs text-muted-foreground"
              title={progress.url}
            >
              {progress.url}
            </div>
          )}
          {progress.event && (
            <div
              className="truncate text-xs italic text-muted-foreground"
              title={progress.event}
            >
              {progress.event}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
