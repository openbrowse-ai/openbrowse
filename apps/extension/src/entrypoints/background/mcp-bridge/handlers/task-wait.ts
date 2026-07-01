import { onTasksChange, tasksStore } from "../../tasks-store";
import { shapeForResult, type TaskStatusResult } from "./task-status";

class RpcError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface TaskWaitParams {
  taskId: string;
  /** Max time to block before returning the current (non-terminal) status. */
  timeoutMs?: number;
}

/** Default block ceiling when the host omits `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
/** Hard cap. Hosts that pass a larger value get clamped. */
export const MAX_WAIT_MS = 900_000; // 15 minutes

const TERMINAL_STATUSES = new Set(["completed", "errored", "cancelled"]);

/**
 * Block until the given task reaches a terminal status or
 * `timeoutMs` elapses, then return the same shape as
 * `task_status`.
 *
 * This is the LLM-friendly façade over async dispatch. A host's
 * model can call `task` then `task_wait` and get the final answer
 * in two calls, never needing to write or reason about a polling
 * loop. Mirrors Exa's `agent_wait_for_run` pattern.
 *
 * Implementation: subscribes to `tasksStore.onTasksChange`,
 * resolves the promise on the first transition to a terminal
 * status for the requested taskId, or on the timeout, whichever
 * fires first. Zero polling.
 *
 * If the task is evicted from `tasksStore` (TTL sweep) while the
 * wait is pending — only possible if the wait outlasts the
 * 10-minute terminal-row retention, which itself starts from
 * status transition — we surface the eviction as a synthetic
 * `errored / task_evicted` outcome rather than hanging. In
 * practice this is unreachable under default settings (eviction
 * starts AFTER terminal status; the listener will already have
 * fired). It's defensive.
 */
export async function handleTaskWait(
  rawParams: unknown,
  ctx: { authContext: { sub: string; client_name?: string }; emitEvent: (e: unknown) => void },
): Promise<TaskStatusResult> {
  const params = (rawParams ?? {}) as Partial<TaskWaitParams>;
  if (typeof params.taskId !== "string" || params.taskId.length === 0) {
    throw new RpcError("missing required parameter: taskId", "invalid_params");
  }

  // Resolve the timeout: negative values clamp to 0 (immediate
  // snapshot return); values above the cap clamp down. NaN /
  // non-numeric become the default — defensive against hosts that
  // forget to JSON-stringify the number.
  const requestedMs = params.timeoutMs;
  const rawMs =
    typeof requestedMs === "number" && Number.isFinite(requestedMs)
      ? requestedMs
      : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(rawMs, 0), MAX_WAIT_MS);

  const initial = tasksStore.getOwnedBy(params.taskId, ctx.authContext.sub);
  if (!initial) {
    throw new RpcError(`task not found: ${params.taskId}`, "task_not_found");
  }

  // Fast path: already terminal. No subscription, no timer.
  if (TERMINAL_STATUSES.has(initial.status)) {
    return shapeForResult(initial);
  }

  // Slow path: subscribe + arm timer + race them.
  return new Promise<TaskStatusResult>((resolve) => {
    let settled = false;
    const finish = (value: TaskStatusResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };

    const unsubscribe = onTasksChange((snapshot) => {
      const t = snapshot.find((x) => x.taskId === params.taskId);
      if (!t) {
        // Task evicted from the store mid-wait. Synthesise an
        // errored outcome carrying the pre-eviction snapshot's
        // identifying fields. In practice this shouldn't happen
        // because the TTL clock starts at the terminal-status
        // transition — by the time eviction fires, the listener
        // has already received the terminal snapshot via the
        // mark*() path above. This branch protects against unusual
        // orderings.
        finish({
          taskId: initial.taskId,
          conversationId: initial.conversationId,
          status: "errored",
          startedAt: initial.startedAt,
          error: {
            code: "task_evicted",
            message: `task ${initial.taskId} was evicted before reaching a terminal state`,
          },
        });
        return;
      }
      if (TERMINAL_STATUSES.has(t.status)) {
        finish(shapeForResult(t));
      }
    });

    const timer = setTimeout(() => {
      // Timeout elapsed: return the current snapshot. The host
      // can call `task_wait` again with the same taskId to keep
      // waiting; status reflects whatever the runner is doing
      // now (typically still `running`).
      const current = tasksStore.getOwnedBy(params.taskId!, ctx.authContext.sub);
      finish(current ? shapeForResult(current) : shapeForResult(initial));
    }, timeoutMs);
  });
}
