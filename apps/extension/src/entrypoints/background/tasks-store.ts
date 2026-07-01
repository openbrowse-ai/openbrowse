/**
 * In-memory registry of MCP tasks across their entire lifecycle.
 *
 * 2026-06-29 async-dispatch overhaul: tasks no longer disappear from
 * the store when their runner terminates. Instead each task carries
 * an explicit `status` field and lingers in the store after
 * completion so the new `task_status` RPC can return final state +
 * output to a polling MCP host. A periodic sweeper evicts terminal
 * tasks once they've outlived `TERMINAL_TTL_MS`.
 *
 * State machine:
 *
 *   register (status: "awaiting_confirmation" | "running")
 *     ├─ setRunning (only meaningful for awaiting_confirmation → running)
 *     ├─ setProgress (lastEvent / currentUrl / stepCounter)
 *     ├─ markCompleted (output)
 *     ├─ markErrored   (error)
 *     ├─ markCancelled
 *     └─ (sweeper after TTL) → evict
 *
 * `cancel(taskId)` is the imperative form of markCancelled — it
 * aborts the abort controller AND flips status.
 */

export type TaskStatus =
  | "awaiting_confirmation"
  | "running"
  | "completed"
  | "errored"
  | "cancelled";

export interface ActiveTask {
  taskId: string;
  clientId: string;        // OAuth client_id (the host)
  hostName: string;        // DCR'd client_name displayed in UI
  prompt: string;
  conversationId: string;
  targetWindowId: number;
  spaceId?: string | null;
  /**
   * Set ONLY when the `task` handler had to create a brand-new Chrome
   * window (the no-existing-windows fallback in `resolveTargetWindow`).
   * Terminal cleanup uses it to remove the window we materialised but
   * never returned to user ownership. Pre-existing windows (explicit
   * windowId, named space, focused-or-first) are not captured here —
   * those belong to the user and we never close them.
   */
  createdWindowId?: number;
  controller: AbortController;
  startedAt: number;
  /**
   * Stable string used for the tab group label. For MCP rows the
   * group placeholder is `OB | MCP · <preview>` (see
   * `tab-scoping.ts:bindTabsToConversation`); the LLM relabeler in
   * `group-label.ts` preserves the `MCP · ` segment.
   */
  taskTitlePreview?: string;

  // ── Async-dispatch fields (2026-06-29) ──────────────────────────
  status: TaskStatus;
  /** Wall-clock ms when status transitioned to a terminal state. */
  endedAt?: number;
  /** Accumulated assistant text on `completed`. */
  output?: string;
  /** Error details on `errored`. */
  error?: { code: string; message: string };
  /** Last user-visible progress event (truncated). */
  lastEvent?: string;
  /** Best-effort URL the agent is currently working on (truncated). */
  currentUrl?: string;
  /** Monotonic tool-call ordinal, mirrors the runner's stepCounter. */
  stepCounter?: number;
  /**
   * Promptid for an in-flight user-confirmation prompt. Set when the
   * task is registered with `awaiting_confirmation` status; cleared
   * once the user decides. `cancel_task` uses this to dismiss the
   * prompt as deny instead of trying to abort a runner that hasn't
   * started yet.
   */
  pendingPromptId?: string;
}

/**
 * How long after a terminal status transition the task row remains
 * in the store. 10 minutes is enough for a polling host to finish
 * pulling final output without indefinitely bloating SW memory.
 *
 * Tasks that survive past this are evicted; subsequent `task_status`
 * RPCs return `task_not_found`. Hosts that need the output past 10
 * minutes can fall back to the chat-db conversation (`source: "mcp"`).
 */
export const TERMINAL_TTL_MS = 10 * 60_000;

/**
 * Cadence at which the sweeper runs. Cheap: a `Date.now()` compare
 * per entry. Misalignment between sweep and TTL means a task can
 * survive up to `TERMINAL_TTL_MS + SWEEP_INTERVAL_MS` post-terminal;
 * we accept that.
 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Max lengths for the progress hint fields. Keeps polling responses
 * compact even if a host polls aggressively and the runner emits
 * verbose events. Long URLs get truncated in the middle so the
 * domain and path tail stay visible.
 */
const MAX_LAST_EVENT_LEN = 200;
const MAX_CURRENT_URL_LEN = 500;

const tasks = new Map<string, ActiveTask>();

/**
 * Subscribe to active-task list changes. The callback fires
 * synchronously on every mutation (register / status transition /
 * cancel / sweep). Returns an unsubscribe fn.
 *
 * Note: the snapshot includes EVERY task in the store, including
 * terminal ones still inside their TTL window. Consumers that want
 * only running tasks should filter by status.
 */
type TaskListener = (snapshot: ActiveTask[]) => void;
const listeners = new Set<TaskListener>();

function notify(): void {
  const snapshot = Array.from(tasks.values());
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch {
      // Defensive: a buggy subscriber must not break task lifecycle.
    }
  }
}

export function onTasksChange(cb: TaskListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Module-private sweeper handle. Started lazily on first
 * register-to-terminal-state transition so tests that never reach a
 * terminal state don't need to clean up timers.
 */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweeperStarted(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  // .unref() lets the SW idle even if the sweeper is still armed. In
  // jsdom/Node this is a no-op on browser-style timers; the real SW
  // doesn't need it for liveness either but it's the conventional
  // hygiene marker.
  const handle = sweepTimer as { unref?: () => void };
  if (typeof handle.unref === "function") handle.unref();
}

function isTerminal(s: TaskStatus): boolean {
  return s === "completed" || s === "errored" || s === "cancelled";
}

function sweep(): void {
  const now = Date.now();
  let mutated = false;
  for (const [taskId, t] of tasks) {
    if (isTerminal(t.status) && t.endedAt != null && now - t.endedAt >= TERMINAL_TTL_MS) {
      tasks.delete(taskId);
      mutated = true;
    }
  }
  if (mutated) notify();
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  if (s.length <= max) return s;
  // Middle-ellide so both the beginning (which usually identifies the
  // origin) and end (which usually carries the most recent state)
  // remain visible.
  const head = Math.floor((max - 1) / 2);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export const tasksStore = {
  /**
   * Register a freshly-dispatched task. `status` is typically
   * `"running"` for auto-confirmed tasks and `"awaiting_confirmation"`
   * for prompt-required ones. Caller is responsible for transitioning
   * via `setRunning` once the user confirms.
   *
   * Idempotent on re-register with the same id (last-write-wins) so
   * a reconnect or retry doesn't double-count.
   */
  register(task: Omit<ActiveTask, "status"> & { status?: TaskStatus }): void {
    const status: TaskStatus = task.status ?? "running";
    const full: ActiveTask = { ...task, status };
    tasks.set(full.taskId, full);
    if (isTerminal(status)) ensureSweeperStarted();
    notify();
  },

  get(taskId: string): ActiveTask | undefined {
    return tasks.get(taskId);
  },

  /** Returns the task only if its clientId matches; used for cancel + status auth. */
  getOwnedBy(taskId: string, clientId: string): ActiveTask | undefined {
    const task = tasks.get(taskId);
    return task && task.clientId === clientId ? task : undefined;
  },

  list(): ActiveTask[] {
    return Array.from(tasks.values());
  },

  /**
   * Patch the conversationId on an existing row. Used by the `task`
   * handler after `runMcpTask` has created the underlying conversation,
   * so the Activity panel can deeplink to it. No-op if unknown.
   */
  updateConversationId(taskId: string, conversationId: string): void {
    const task = tasks.get(taskId);
    if (!task) return;
    task.conversationId = conversationId;
    notify();
  },

  /**
   * Promote a task from `awaiting_confirmation` to `running`. No-op
   * if the task is already running or unknown.
   */
  setRunning(taskId: string): void {
    const task = tasks.get(taskId);
    if (!task) return;
    if (task.status !== "awaiting_confirmation") return;
    task.status = "running";
    task.pendingPromptId = undefined;
    notify();
  },

  /**
   * Record an in-flight progress hint. Both fields are optional;
   * passing undefined leaves the prior value in place.
   */
  setProgress(
    taskId: string,
    update: { lastEvent?: string; currentUrl?: string; stepCounter?: number },
  ): void {
    const task = tasks.get(taskId);
    if (!task) return;
    if (update.lastEvent !== undefined) {
      task.lastEvent = truncate(update.lastEvent, MAX_LAST_EVENT_LEN);
    }
    if (update.currentUrl !== undefined) {
      task.currentUrl = truncate(update.currentUrl, MAX_CURRENT_URL_LEN);
    }
    if (update.stepCounter !== undefined) {
      task.stepCounter = update.stepCounter;
    }
    notify();
  },

  /**
   * Remember the promptId for the pending user-confirmation prompt
   * tied to this task. `cancel_task` uses it to dismiss the prompt
   * as deny when the host cancels a not-yet-confirmed task.
   */
  setPendingPromptId(taskId: string, promptId: string): void {
    const task = tasks.get(taskId);
    if (!task) return;
    task.pendingPromptId = promptId;
    notify();
  },

  markCompleted(taskId: string, output: string): void {
    const task = tasks.get(taskId);
    if (!task) return;
    task.status = "completed";
    task.output = output;
    task.endedAt = Date.now();
    ensureSweeperStarted();
    notify();
  },

  markErrored(taskId: string, error: { code: string; message: string }): void {
    const task = tasks.get(taskId);
    if (!task) return;
    task.status = "errored";
    task.error = error;
    task.endedAt = Date.now();
    ensureSweeperStarted();
    notify();
  },

  markCancelled(taskId: string): void {
    const task = tasks.get(taskId);
    if (!task) return;
    task.status = "cancelled";
    task.endedAt = Date.now();
    ensureSweeperStarted();
    notify();
  },

  /**
   * Hard-remove a task from the store immediately. Bypasses the TTL.
   * Used only by tests and by the legacy `clear` shim below.
   */
  clear(taskId: string): void {
    const existed = tasks.delete(taskId);
    if (existed) notify();
  },

  /**
   * Cancels an in-flight task. Aborts its controller and transitions
   * status to `cancelled`. Returns false if the task is unknown.
   *
   * The task is NOT removed from the store immediately — it lingers
   * in terminal state for `TERMINAL_TTL_MS` so a polling host can
   * still see the cancellation outcome.
   */
  cancel(taskId: string): boolean {
    const task = tasks.get(taskId);
    if (!task) return false;
    // Aborting an already-aborted controller is harmless.
    try {
      task.controller.abort();
    } catch {
      // ignore
    }
    task.status = "cancelled";
    task.endedAt = Date.now();
    ensureSweeperStarted();
    notify();
    return true;
  },

  /**
   * Test-only: stop the sweeper. Real SWs never call this — the
   * sweeper lives for the SW's lifetime.
   */
  _stopSweeperForTests(): void {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  },

  /**
   * Test-only: reset the entire store (clear all entries and stop
   * the sweeper). Real SWs never call this.
   */
  _resetForTests(): void {
    tasks.clear();
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  },
};
