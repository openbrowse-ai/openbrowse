// src/entrypoints/background/scheduler.ts
import { taskDb } from "@/lib/schedule/task-db";
import { computeNextRun } from "@/lib/schedule/next-run";

export const SCHEDULER_ALARM = "scheduler-tick";
const PERIOD_MINUTES = 1;

/**
 * Read all tasks and dispatch any that are due: enabled, with a numeric
 * nextRunAt <= now, and not already running. `runOne` performs the actual
 * run (injected so tests don't spin up a real agent loop).
 */
export async function runDueTasks(
  now: number,
  runOne: (taskId: string) => Promise<void>,
): Promise<void> {
  const tasks = await taskDb.list();
  for (const t of tasks) {
    if (!t.enabled) continue;
    if (t.lastRunStatus === "running") continue;
    if (typeof t.nextRunAt !== "number") continue;
    if (t.nextRunAt > now) continue;
    try {
      await runOne(t.id);
    } catch (err) {
      console.warn(`[scheduler] task ${t.id} run failed:`, err);
    }
  }
}

/**
 * On startup, recompute nextRunAt for every task from `now`. Missed runs are
 * skipped: a task whose time passed while Chrome was closed gets its NEXT
 * future occurrence, not an immediate fire.
 */
export async function rescheduleAll(now: number): Promise<void> {
  const tasks = await taskDb.list();
  for (const t of tasks) {
    const next = computeNextRun(t.schedule, now);
    if (next !== t.nextRunAt) {
      await taskDb.update(t.id, { nextRunAt: next });
    }
    // Clear any stale "running" left by an SW teardown mid-run.
    if (t.lastRunStatus === "running") {
      await taskDb.update(t.id, {
        lastRunStatus: "error",
        lastRunError: "interrupted",
      });
    }
  }
}

/** Default production run: host the run in a home page and await its result. */
async function runOneProduction(taskId: string): Promise<void> {
  const { runScheduledTask, createHomeHostDeps } = await import(
    "@/lib/agent/scheduled-run"
  );
  const hostDeps = createHomeHostDeps();
  await runScheduledTask(taskId, {
    ...hostDeps,
    notify: (payload) => {
      chrome.runtime
        ?.sendMessage?.({ type: "AGENT_NOTIFY", payload })
        ?.catch?.(() => {});
    },
  });
}

export function registerScheduler(): void {
  chrome.alarms.create(SCHEDULER_ALARM, { periodInMinutes: PERIOD_MINUTES });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SCHEDULER_ALARM) return;
    void runDueTasks(Date.now(), runOneProduction).catch((err) => {
      console.warn("[scheduler] tick failed:", err);
    });
  });

  // Opportunistic startup reschedule (skip missed runs).
  void rescheduleAll(Date.now()).catch((err) => {
    console.warn("[scheduler] startup reschedule failed:", err);
  });
}
