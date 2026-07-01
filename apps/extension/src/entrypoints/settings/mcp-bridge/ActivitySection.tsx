import { useCallback, useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { ActiveTaskCard } from "./ActiveTaskCard";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { RecentTaskRow } from "./RecentTaskRow";
import { useActiveTasks } from "./useActiveTasks";
import { usePendingPrompts } from "./usePendingPrompts";
import { useRecentTasks } from "./useRecentTasks";

/**
 * Activity section — the new home of the (Phase 2-3) Background Tasks
 * UI inside Settings → MCP Server. Three sub-areas, all push-driven:
 *
 *   1. Pending confirmations (rare; only when a host's policy is
 *      `always-prompt`, or the tool args force `confirmation: "prompt"`,
 *      or the global `Always confirm` toggle is on).
 *   2. Active tasks (running right now). Stop button per row.
 *   3. Recent finished tasks (7-day window from chat-db). Click → open.
 *
 * Recents re-fetch whenever active tasks transition from non-empty to
 * empty — that's the only signal we have that a task just completed.
 */
export function ActivitySection() {
  const prompts = usePendingPrompts();
  const allTasks = useActiveTasks();
  const { tasks: recent, refresh: refreshRecent } = useRecentTasks();
  const [autoDenyMs, setAutoDenyMs] = useState<number | undefined>(undefined);

  // Split tasks by status. The tasks port now pushes terminal-state
  // rows too (within the 10-min TTL) so the UI sees the transition.
  // `awaiting_confirmation` and `running` collapse into one
  // user-facing concept — "happening right now" — because both are
  // states where the user can cancel and the host is waiting.
  const liveTasks = allTasks.filter(
    (t) => t.status === "running" || t.status === "awaiting_confirmation",
  );

  // Read the auto-deny setting once on mount; the UI countdown is a
  // best-effort caption (the SW is authoritative for the actual
  // timeout). Re-reading on every prompt change would be churn.
  useEffect(() => {
    void (async () => {
      const s = await storage.getSettings();
      setAutoDenyMs(s.mcpAutoDenyMs);
    })();
  }, []);

  // Edge detection: when the live-tasks list shrinks to empty,
  // refresh recents (something just completed) so the chat-db row
  // shows up promptly.
  const [lastLiveCount, setLastLiveCount] = useState(liveTasks.length);
  useEffect(() => {
    if (lastLiveCount > 0 && liveTasks.length === 0) {
      void refreshRecent();
    }
    setLastLiveCount(liveTasks.length);
  }, [liveTasks.length, lastLiveCount, refreshRecent]);

  // No prompts, no live tasks, no recents — friendly empty state.
  const isEmpty =
    prompts.length === 0 && liveTasks.length === 0 && recent.length === 0;
  if (isEmpty) {
    return (
      <div className="text-sm text-muted-foreground">
        No MCP activity yet. When an MCP client runs a task in your
        browser it'll show up here.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {prompts.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Awaiting your confirmation
          </div>
          {prompts.map((p) => (
            <ConfirmationDialog
              key={p.promptId}
              prompt={p}
              autoDenyAt={
                autoDenyMs === undefined
                  ? p.createdAt + 60_000
                  : autoDenyMs <= 0
                  ? null
                  : p.createdAt + autoDenyMs
              }
              onResolved={() => {
                // No-op — the prompts port will push a fresh snapshot
                // after the SW confirmPrompt drains the entry.
              }}
            />
          ))}
        </div>
      )}

      {liveTasks.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Running now
          </div>
          {liveTasks.map((t) => (
            <ActiveTaskCard
              key={t.taskId}
              task={t}
              onCancelled={() => {
                // Tasks port pushes a fresh snapshot when the SW
                // tasksStore mutates; recents refresh on the
                // live-count transition above.
              }}
            />
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <RecentList refresh={refreshRecent} recent={recent} />
      )}
    </div>
  );
}

function RecentList({
  recent,
  refresh,
}: {
  recent: ReturnType<typeof useRecentTasks>["tasks"];
  refresh: () => Promise<void>;
}) {
  const onRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase text-muted-foreground">
          Recent (last 7 days)
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Refresh
        </button>
      </div>
      {recent.map((t) => (
        <RecentTaskRow key={t.conversationId} task={t} />
      ))}
    </div>
  );
}
