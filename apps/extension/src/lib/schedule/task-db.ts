// src/lib/schedule/task-db.ts
import { getChatDbConnection, type ScheduledTaskRow } from "@/lib/chat-db";
import { computeNextRun } from "./next-run";
import type { ScheduledTask } from "./types";

export type CreateScheduledTaskInput = Omit<
  ScheduledTask,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "nextRunAt"
  | "lastRunAt"
  | "lastRunStatus"
  | "lastRunConversationId"
  | "lastRunError"
  | "taskConversationId"
  | "autoApprove"
> &
  Partial<
    Pick<ScheduledTask, "taskConversationId" | "sourceConversationId" | "autoApprove">
  >;

type TaskChangeListener = () => void;
const listeners = new Set<TaskChangeListener>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn("[task-db] listener threw:", err);
    }
  }
}

function newId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const taskDb = {
  async create(input: CreateScheduledTaskInput): Promise<ScheduledTaskRow> {
    const now = Date.now();
    const row: ScheduledTaskRow = {
      ...input,
      autoApprove: input.autoApprove ?? false,
      id: newId(),
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRun(input.schedule, now),
    };
    const db = await getChatDbConnection();
    await db.put("scheduledTasks", row);
    emit();
    return row;
  },

  async get(id: string): Promise<ScheduledTaskRow | undefined> {
    const db = await getChatDbConnection();
    return db.get("scheduledTasks", id);
  },

  async list(): Promise<ScheduledTaskRow[]> {
    const db = await getChatDbConnection();
    const all = await db.getAll("scheduledTasks");
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },

  /**
   * Shallow-merge update. If `schedule` is part of the patch, `nextRunAt`
   * is recomputed from the new schedule (unless the caller explicitly set
   * `nextRunAt` in the same patch).
   */
  async update(id: string, patch: Partial<ScheduledTaskRow>): Promise<void> {
    const db = await getChatDbConnection();
    const existing = await db.get("scheduledTasks", id);
    if (!existing) return;
    const merged: ScheduledTaskRow = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    if (patch.schedule !== undefined && patch.nextRunAt === undefined) {
      merged.nextRunAt = computeNextRun(merged.schedule, Date.now());
    }
    await db.put("scheduledTasks", merged);
    emit();
  },

  /**
   * Atomically claim a task for a run: within a single IDB transaction, set
   * `lastRunStatus = "running"` only if it isn't already "running". Returns
   * true if this caller won the claim (and should proceed with the run),
   * false if the task is missing or already running. This closes the
   * check-then-update (TOCTOU) gap between a `get` and a later `update` when
   * an alarm tick and a "run now" request race for the same task.
   */
  async claimRun(id: string): Promise<boolean> {
    const db = await getChatDbConnection();
    const tx = db.transaction("scheduledTasks", "readwrite");
    const existing = await tx.store.get(id);
    if (!existing || existing.lastRunStatus === "running") {
      await tx.done;
      return false;
    }
    await tx.store.put({
      ...existing,
      lastRunStatus: "running",
      updatedAt: Date.now(),
    });
    await tx.done;
    emit();
    return true;
  },

  async remove(id: string): Promise<void> {
    const db = await getChatDbConnection();
    await db.delete("scheduledTasks", id);
    emit();
  },

  subscribe(listener: TaskChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
