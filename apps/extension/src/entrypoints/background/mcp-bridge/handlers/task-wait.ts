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
 * Clamp a host-supplied timeout to a safe bounded range. Returns
 * `DEFAULT_TIMEOUT_MS` for anything non-numeric or NaN. Never
 * returns a value greater than `MAX_WAIT_MS` or less than 0 — this
 * is a security property (host-controlled timers must not exhaust
 * SW resources), enforced with explicit comparisons rather than
 * `Math.min/max` so static analysis (CodeQL js/resource-exhaustion)
 * recognises the bound.
 */
function clampTimeoutMs(input: unknown): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (input < 0) return 0;
  if (input > MAX_WAIT_MS) return MAX_WAIT_MS;
  return input;
}

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

  // Resolve the timeout via the pure clampTimeoutMs helper: negative
  // values → 0 (immediate snapshot); values above MAX_WAIT_MS → clamp
  // down; non-numeric → default. Extracting the clamp to a dedicated
  // function makes the security bound explicit (see clampTimeoutMs).
  const timeoutMs = clampTimeoutMs(params.timeoutMs);

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
      // Re-clamp inline with a constant literal ceiling so static
      // analysis (js/resource-exhaustion) sees a syntactic
      // sanitisation right here at the call site, in addition to
      // the clampTimeoutMs helper above. Belt-and-braces.
    }, timeoutMs > MAX_WAIT_MS ? MAX_WAIT_MS : timeoutMs < 0 ? 0 : timeoutMs);
  });
}
