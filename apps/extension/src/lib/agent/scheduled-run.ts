// src/lib/agent/scheduled-run.ts
import { chatDb } from "@/lib/chat-db";
import { taskDb } from "@/lib/schedule/task-db";
import { computeNextRun } from "@/lib/schedule/next-run";

/** Outcome of the run, surfaced by the home-page host via SCHEDULED_RUN_DONE. */
export interface ScheduledLoopResult {
  finalText: string;
  status: "success" | "error";
  errorMessage?: string;
}

/** Args identifying the run to host + await. */
export interface ScheduledLoopArgs {
  taskId: string;
  childConversationId: string;
}

export interface NotifyPayload {
  kind: "complete";
  conversationId: string;
  snippet: string;
  origin: "home";
}

export interface RunScheduledTaskDeps {
  /**
   * Ensure a home page exists to host the run, record the pending run, and
   * broadcast the host request. The agent itself runs in that home page (the
   * only realm with DOM + chrome.debugger/tabs/scripting).
   */
  hostRun: (args: ScheduledLoopArgs) => Promise<void>;
  /** Await the home page's SCHEDULED_RUN_DONE for this run (with timeout). */
  awaitResult: (args: ScheduledLoopArgs) => Promise<ScheduledLoopResult>;
  notify: (payload: NotifyPayload) => void;
  now?: () => number;
}

export interface RunScheduledTaskResult {
  status: "success" | "error" | "skipped";
  childConversationId?: string;
}

/**
 * Orchestrate one scheduled task: ensure a home page hosts the run, await its
 * result, then update bookkeeping + notify. The agent runs as a background
 * chat in the home page; its work tabs are isolated via the normal tab-group
 * machinery. Returns "skipped" when the task is gone or already running.
 */
export async function runScheduledTask(
  taskId: string,
  deps: RunScheduledTaskDeps,
): Promise<RunScheduledTaskResult> {
  const now = deps.now ?? Date.now;
  const task = await taskDb.get(taskId);
  if (!task) return { status: "skipped" };

  // Guard against starting a second concurrent run of the same task.
  if (task.lastRunStatus === "running") return { status: "skipped" };

  // Mark running so a concurrent tick won't double-fire this task.
  await taskDb.update(taskId, { lastRunStatus: "running" });

  // Ensure a parent "task" conversation exists to own this run's transcript.
  let taskConversationId = task.taskConversationId;
  if (!taskConversationId) {
    taskConversationId = `task-conv-${taskId}`;
    await chatDb.createConversation({
      id: taskConversationId,
      title: task.name,
      spaceId: null,
      parentConversationId: null,
      subagentSlug: "scheduled",
      subagentStatus: null,
      createdAt: now(),
      updatedAt: now(),
    });
    await taskDb.update(taskId, { taskConversationId });
  }

  // Create the child (per-run) conversation.
  const childConversationId = `sched-run-${taskId}-${now()}`;
  await chatDb.createConversation({
    id: childConversationId,
    title: `${task.name} — ${new Date(now()).toLocaleString()}`,
    spaceId: null,
    parentConversationId: taskConversationId,
    subagentSlug: "scheduled",
    subagentStatus: "running",
    createdAt: now(),
    updatedAt: now(),
  });

  let result: ScheduledLoopResult;
  try {
    // Hand the run to a home page (ensure one exists), then await its result.
    await deps.hostRun({ taskId, childConversationId });
    result = await deps.awaitResult({ taskId, childConversationId });
  } catch (err) {
    result = {
      finalText: "",
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  // Finalize child conversation status.
  await chatDb.updateConversation(childConversationId, {
    subagentStatus: result.status === "success" ? "completed" : "failed",
    subagentFinalText: result.finalText,
  });

  // Update task bookkeeping + recompute next run.
  await taskDb.update(taskId, {
    lastRunAt: now(),
    lastRunStatus: result.status,
    lastRunConversationId: childConversationId,
    lastRunError: result.status === "error" ? result.errorMessage : undefined,
    nextRunAt: computeNextRun(task.schedule, now()),
  });

  // Notify.
  const snippet =
    result.status === "success"
      ? result.finalText.slice(0, 120) || `${task.name} finished`
      : `${task.name} failed: ${result.errorMessage ?? "unknown error"}`;
  deps.notify({
    kind: "complete",
    conversationId: childConversationId,
    snippet,
    origin: "home",
  });

  return { status: result.status, childConversationId };
}

const PENDING_RUNS_KEY = "scheduled-pending-runs";

interface PendingRun {
  childConversationId: string;
  taskId: string;
}

/**
 * Production deps: host the run in a home page and await its result.
 *
 *  - `hostRun`: ensure a home page exists (reuse an existing one, else open a
 *    pinned UNFOCUSED home tab in the current window), record the pending run
 *    in session storage (so a freshly-opened page can late-join), broadcast
 *    SCHEDULER_HOST_RUN, and start listening for the result.
 *  - `awaitResult`: resolve when the hosting page posts SCHEDULED_RUN_DONE for
 *    this run (or on timeout).
 *
 * The agent runs as a background chat in the home page; its work tabs are
 * isolated by the normal tab-group machinery (no dedicated window).
 */
export function createHomeHostDeps(
  timeoutMs = 10 * 60_000,
): Pick<RunScheduledTaskDeps, "hostRun" | "awaitResult"> {
  const waiters = new Map<
    string,
    { resolve: (r: ScheduledLoopResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let listenerAttached = false;

  function onMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as {
      type?: string;
      childConversationId?: string;
      status?: "success" | "error";
      finalText?: string;
      errorMessage?: string;
    };
    if (m.type !== "SCHEDULED_RUN_DONE" || !m.childConversationId) return;
    const waiter = waiters.get(m.childConversationId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiters.delete(m.childConversationId);
    waiter.resolve({
      status: m.status === "success" ? "success" : "error",
      finalText: m.finalText ?? "",
      errorMessage: m.errorMessage,
    });
  }

  return {
    async hostRun({ taskId, childConversationId }) {
      if (!listenerAttached) {
        chrome.runtime.onMessage.addListener(onMessage);
        listenerAttached = true;
      }
      // Record the pending run so a home page opened after this broadcast can
      // late-join (scans session storage on mount).
      try {
        const r = await chrome.storage.session.get(PENDING_RUNS_KEY);
        const list: PendingRun[] = Array.isArray(r[PENDING_RUNS_KEY])
          ? (r[PENDING_RUNS_KEY] as PendingRun[])
          : [];
        if (!list.some((p) => p.childConversationId === childConversationId)) {
          list.push({ childConversationId, taskId });
          await chrome.storage.session.set({ [PENDING_RUNS_KEY]: list });
        }
      } catch {
        // session storage unavailable; live broadcast still covers open pages
      }

      await ensureHomePage();

      chrome.runtime
        ?.sendMessage?.({ type: "SCHEDULER_HOST_RUN", childConversationId, taskId })
        ?.catch?.(() => {});
    },

    awaitResult({ childConversationId }) {
      return new Promise<ScheduledLoopResult>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(childConversationId);
          resolve({
            status: "error",
            finalText: "",
            errorMessage: `Scheduled run timed out after ${Math.round(timeoutMs / 60000)} min.`,
          });
        }, timeoutMs);
        waiters.set(childConversationId, { resolve, timer });
      });
    },
  };
}

/**
 * Ensure at least one home.html page exists to host runs. Reuses an existing
 * one if present; otherwise opens a pinned, UNFOCUSED home tab in the current
 * window so it doesn't interrupt the user.
 */
async function ensureHomePage(): Promise<void> {
  const homeUrl = chrome.runtime.getURL("/home.html");
  try {
    const existing = await chrome.tabs.query({ url: `${homeUrl}*` });
    if (existing.length > 0) return;
  } catch {
    // fall through to open one
  }
  try {
    await chrome.tabs.create({ url: homeUrl, pinned: true, active: false });
  } catch (err) {
    console.warn("[scheduler] failed to open home page for run:", err);
  }
}


