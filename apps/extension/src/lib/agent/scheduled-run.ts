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
   * broadcast the host request.
   *
   * Architectural note (post-SW-host migration, 2026-06-25): the agent
   * loop runs in the service worker now, not in the home page. The home
   * page is the connection holder: its `useAgentChat`-built
   * `RemoteChatTransport` opens an `agent-run:<conversationId>` Port to
   * the SW, which then drives the LLM stream + tools. Deleting the
   * home-page host indirection is possible (the SW could initiate the
   * run directly) but is deferred — see
   * `.superpowers/plans/2026-06-25-sw-host-agent-runs.md` Task 8.
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

  // Atomically claim the task: sets lastRunStatus="running" only if it isn't
  // already running, in one IDB transaction. This closes the TOCTOU gap where
  // an alarm tick and a "run now" request both pass a separate get() guard and
  // then double-fire the same task.
  const claimed = await taskDb.claimRun(taskId);
  if (!claimed) return { status: "skipped" };

  const task = await taskDb.get(taskId);
  // Defensive: claimRun returned true, so the row existed a moment ago.
  if (!task) return { status: "skipped" };

  // Pre-host setup: create the parent + per-run conversations. If any of this
  // throws, the task would otherwise stay stuck as "running" until the next
  // SW startup reschedule — so mark it failed here and bail.
  let childConversationId: string;
  try {
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
    childConversationId = `sched-run-${taskId}-${now()}`;
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
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await taskDb.update(taskId, {
      lastRunStatus: "error",
      lastRunError: errorMessage,
      lastRunAt: now(),
      nextRunAt: computeNextRun(task.schedule, now()),
    });
    return { status: "error" };
  }

  let result: ScheduledLoopResult;
  try {
    // Register the result waiter BEFORE broadcasting the host request, so a
    // home page that runs and posts SCHEDULED_RUN_DONE immediately can't beat
    // the waiter registration (which would strand the run until timeout).
    const resultPromise = deps.awaitResult({ taskId, childConversationId });
    await deps.hostRun({ taskId, childConversationId });
    result = await resultPromise;
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
 * Lazily-initialized singleton of the production host deps. `createHomeHostDeps`
 * attaches a `chrome.runtime.onMessage` listener (on first `hostRun`) that lives
 * for the SW's lifetime; creating a fresh deps object per tick / per "run now"
 * would accumulate one listener per invocation. Callers must reuse this single
 * instance so exactly one listener exists.
 */
let homeHostDepsSingleton:
  | Pick<RunScheduledTaskDeps, "hostRun" | "awaitResult">
  | null = null;

export function getHomeHostDeps(): Pick<
  RunScheduledTaskDeps,
  "hostRun" | "awaitResult"
> {
  if (!homeHostDepsSingleton) {
    homeHostDepsSingleton = createHomeHostDeps();
  }
  return homeHostDepsSingleton;
}

/**
 * Ensure at least one home.html page exists to host runs. Reuses an existing
 * one if present; otherwise opens a pinned, UNFOCUSED home tab in the current
 * window so it doesn't interrupt the user.
 *
 * Hosts MUST be home.html, never newtab.html. Newtab pages are ephemeral
 * (they close the moment the user navigates) and unsuitable as a durable
 * background-run host. The query below pins the host URL to /home.html
 * specifically; do not generalize it to "any extension page" or scheduled
 * runs will start being adopted by, then losing their host with, NTP tabs.
 */
export async function ensureHomePage(): Promise<void> {
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


