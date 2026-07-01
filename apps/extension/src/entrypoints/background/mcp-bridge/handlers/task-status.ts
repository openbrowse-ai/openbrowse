import { tasksStore, type ActiveTask, type TaskStatus } from "../../tasks-store";

class RpcError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface TaskStatusParams {
  taskId: string;
}

export interface TaskStatusProgress {
  step: number;
  lastEvent: string;
  currentUrl?: string;
}

export interface TaskStatusResult {
  taskId: string;
  conversationId: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  output?: string;
  error?: { code: string; message: string };
  progress?: TaskStatusProgress;
}

/**
 * Shape an internal `ActiveTask` row as the wire result. Exported
 * so the `task_wait` handler can reuse the same projection — the
 * field-by-field mapping has security-relevant invariants
 * (clientId never leaked, undefineds omitted not stringified) and
 * is worth pinning in one place.
 */
export function shapeForResult(task: ActiveTask): TaskStatusResult {
  const result: TaskStatusResult = {
    taskId: task.taskId,
    conversationId: task.conversationId,
    status: task.status,
    startedAt: task.startedAt,
  };
  if (task.endedAt !== undefined) result.endedAt = task.endedAt;
  if (task.output !== undefined) result.output = task.output;
  if (task.error !== undefined) result.error = task.error;
  if (task.lastEvent !== undefined) {
    result.progress = {
      step: task.stepCounter ?? 0,
      lastEvent: task.lastEvent,
      ...(task.currentUrl !== undefined ? { currentUrl: task.currentUrl } : {}),
    };
  }
  return result;
}

/**
 * Return the current state of an async-dispatched `task`. The host
 * polls this RPC after `task` returns a handle.
 *
 * Authorisation: the task is only returned to the client that
 * dispatched it (via `getOwnedBy`). Cross-host probes for a known
 * taskId return `task_not_found` rather than leaking the existence
 * of a peer's task.
 *
 * Lookup order:
 *   1. `tasksStore` — covers live tasks AND terminal tasks within
 *      the `TERMINAL_TTL_MS` window (10 min). The store keeps
 *      output/error/endedAt fields on terminal rows so we can
 *      return final state without a chat-db round-trip.
 *   2. (Future) Fall back to chat-db for evicted-from-memory tasks.
 *      Not implemented in this commit — the 10-minute window covers
 *      the vast majority of polling-host UX. Hosts that need to
 *      retrieve output beyond the window should use the
 *      `conversationId` (returned from `task`) to deep-link into the
 *      OpenBrowse Activity panel.
 */
export async function handleTaskStatus(
  rawParams: unknown,
  ctx: { authContext: { sub: string; client_name?: string }; emitEvent: (e: unknown) => void },
): Promise<TaskStatusResult> {
  const params = (rawParams ?? {}) as Partial<TaskStatusParams>;
  if (typeof params.taskId !== "string" || params.taskId.length === 0) {
    throw new RpcError("missing required parameter: taskId", "invalid_params");
  }

  const task = tasksStore.getOwnedBy(params.taskId, ctx.authContext.sub);
  if (!task) {
    throw new RpcError(`task not found: ${params.taskId}`, "task_not_found");
  }
  return shapeForResult(task);
}
