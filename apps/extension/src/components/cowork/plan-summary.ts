import type { TodoItem } from "@/lib/types";

export interface PlanSummary {
  /** Number of completed tasks. */
  done: number;
  /** Total tasks, including cancelled. */
  total: number;
  /** Content of the first in_progress task, or null if none. */
  live: string | null;
}

/** Collapsed-state summary for the composer cowork bar. */
export function planSummary(todos: TodoItem[]): PlanSummary {
  const done = todos.filter((t) => t.status === "completed").length;
  const live = todos.find((t) => t.status === "in_progress")?.content ?? null;
  return { done, total: todos.length, live };
}
