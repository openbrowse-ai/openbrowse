import { useCallback, useEffect, useState } from "react";
import { chatDb } from "@/lib/chat-db";
import type { RecentTaskSummary } from "./RecentTaskRow";

const DAYS_BACK = 7;
const LIMIT = 50;

/**
 * Load recent MCP-spawned conversations directly from IndexedDB.
 *
 * Unlike the active-tasks list this isn't push-driven — recents
 * change only when a task completes and the Activity section is the
 * one re-rendering it, so a one-shot fetch on mount plus a manual
 * refresher is enough. The hook exposes a `refresh` fn for the
 * outer component to call after it observes an active task
 * disappear (i.e. just completed).
 */
export function useRecentTasks(): {
  tasks: RecentTaskSummary[];
  refresh: () => Promise<void>;
} {
  const [tasks, setTasks] = useState<RecentTaskSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      const rows = await chatDb.listMcpConversations({
        limit: LIMIT,
        sinceDays: DAYS_BACK,
      });
      setTasks(
        rows.map((c) => ({
          conversationId: c.id,
          hostName: c.mcpHostName ?? "Unknown",
          promptPreview: c.title,
          completedAt: c.updatedAt,
        })),
      );
    } catch {
      // chat-db unavailable (e.g. tests with no IDB stub); leave the
      // last good value in place. The Activity section's empty state
      // covers the initial-failure path.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { tasks, refresh };
}
