import { confirmPrompt } from "../confirmation";
import { tasksStore } from "../../tasks-store";

class RpcError extends Error {
  constructor(message: string, public readonly code: string) { super(message); }
}

export interface CancelTaskParams { taskId: string }
export interface CancelTaskResult { cancelled: boolean; taskId: string }

/**
 * Cancel an in-flight MCP task.
 *
 * Tab cleanup is NOT performed inline. Aborting the runner's
 * controller causes `task.ts`'s aborted-branch to fire its terminal
 * cleanup via `runCleanupForTask("cancelled")` — that's the single
 * source of truth for "task ended → clean up tabs/windows", and it
 * also covers user-initiated stop (which never routes through this
 * handler).
 */
export async function handleCancelTask(
  rawParams: unknown,
  ctx: { authContext: { sub: string; client_name?: string }; emitEvent: (e: unknown) => void },
): Promise<CancelTaskResult> {
  const params = (rawParams ?? {}) as Partial<CancelTaskParams>;
  if (typeof params.taskId !== "string" || params.taskId.length === 0) {
    throw new RpcError("missing required parameter: taskId", "invalid_params");
  }

  const task = tasksStore.getOwnedBy(params.taskId, ctx.authContext.sub);
  if (!task) {
    // Return task_not_found for both unknown ids and cross-client probes
    // to prevent id enumeration across hosts.
    throw new RpcError(`task not found: ${params.taskId}`, "task_not_found");
  }

  // A task in `awaiting_confirmation` is blocked on a user prompt —
  // the agent runner hasn't started yet. Cancelling means dismissing
  // the prompt as deny; the awaiter in `task.ts` then marks the task
  // as cancelled and fires `runCleanupForTask("cancelled")` itself
  // (no agent-opened tabs to clean, but a `createdWindowId` may need
  // removing). We do NOT also call `tasksStore.cancel` because the
  // prompt-deny path already routes through markCancelled.
  if (task.status === "awaiting_confirmation" && task.pendingPromptId) {
    confirmPrompt(task.pendingPromptId, "deny");
    ctx.emitEvent({ kind: "user-confirmed", outcome: "deny" });
    return { cancelled: true, taskId: params.taskId };
  }

  // Running or terminal-but-not-yet-evicted: imperative cancel.
  // `tasksStore.cancel` aborts the controller (no-op if already
  // terminated) and flips status to `cancelled`. The runner's
  // aborted-branch in `task.ts` then triggers
  // `runCleanupForTask("cancelled")`.
  tasksStore.cancel(params.taskId);
  ctx.emitEvent({ kind: "user-confirmed", outcome: "deny" });

  return { cancelled: true, taskId: params.taskId };
}
