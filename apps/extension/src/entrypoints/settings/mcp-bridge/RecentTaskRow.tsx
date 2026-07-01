import { useCallback } from "react";
import { openOrFocusConversation } from "./open-conversation";

export interface RecentTaskSummary {
  conversationId: string;
  hostName: string;
  /** First user-message preview (or conversation title) — short. */
  promptPreview: string;
  /** epoch-ms of the most recent update; for MCP rows = completion. */
  completedAt: number;
}

/**
 * Pure helper, exported for unit testing: format an absolute epoch-ms
 * timestamp as a compact relative caption ("just now", "5 min ago",
 * "3h ago", "2d ago"). Falls back to a locale-formatted date for
 * older entries.
 */
export function formatCompletedAt(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export interface RecentTaskRowProps {
  task: RecentTaskSummary;
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
}

export function RecentTaskRow({ task, now = Date.now }: RecentTaskRowProps) {
  // Settings page is a separate top-level entrypoint, so we can't
  // mutate `window.location.hash` to navigate. `openOrFocusConversation`
  // looks for an existing home tab on this conversation and focuses
  // it; otherwise creates a new tab. Falls back to `window.open` if
  // the privileged tabs API throws.
  const onOpen = useCallback(() => {
    void openOrFocusConversation(task.conversationId);
  }, [task.conversationId]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start justify-between rounded border border-border p-3 text-left hover:bg-accent"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
            {task.hostName}
          </span>
          <span className="text-muted-foreground">
            {formatCompletedAt(task.completedAt, now())}
          </span>
        </div>
        <div className="mt-1 truncate text-sm">{task.promptPreview}</div>
      </div>
    </button>
  );
}
