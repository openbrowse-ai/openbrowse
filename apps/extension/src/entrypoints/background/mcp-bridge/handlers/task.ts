import { awaitConfirmation } from "../confirmation";
import { runCleanupForTask } from "../cleanup-runtime";
import {
  preflightAgent,
  runMcpTask,
  type McpTaskEvent,
} from "../mcp-task-runner";
import {
  progressFromStepFinish,
  progressFromStepStart,
} from "../progress";
import { tasksStore, type TaskStatus } from "../../tasks-store";
import { storage } from "@/lib/storage";

export interface TaskParams {
  prompt: string;
  space?: string;
  windowId?: number;
  confirmation?: "auto" | "prompt";
}

/**
 * Output of an async-dispatched `task` call. The host receives this
 * within ~1 s of the call (or up to consent timeout if the user has
 * not yet allowed it). To retrieve the final assistant text, the
 * host polls `task_status` with `taskId`.
 *
 * `status` is one of:
 *   - `"awaiting_confirmation"`: the per-host policy requires a
 *     prompt and the user hasn't decided. Host should poll
 *     `task_status` until it transitions.
 *   - `"running"`: agent loop is running. Host should poll
 *     `task_status` for `progress` and final state.
 */
export interface TaskResult {
  taskId: string;
  conversationId: string;
  status: TaskStatus;
  startedAt: number;
}

class RpcError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

function newTaskId(): string {
  const buf = new Uint8Array(12);
  const c = (globalThis as { crypto?: { getRandomValues(b: Uint8Array): Uint8Array } }).crypto;
  if (c) c.getRandomValues(buf);
  else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveTargetWindow(
  params: TaskParams,
): Promise<{
  windowId: number;
  spaceId: string | null;
  spaceName?: string;
  /**
   * Set ONLY when this handler created a brand-new Chrome window
   * because no windows existed. Captured so terminal cleanup can
   * remove the window after closing its tabs. Undefined for the
   * explicit-windowId and named-space paths (those windows are
   * user-owned / space-persistent — we never close them).
   */
  createdWindowId?: number;
}> {
  if (typeof params.windowId === "number") {
    try {
      await chrome.windows.get(params.windowId);
      return { windowId: params.windowId, spaceId: null };
    } catch {
      throw new RpcError(`window not found: ${params.windowId}`, "window_not_found");
    }
  }
  if (params.space) {
    const spaces = await storage.getSpaces();
    const target = spaces.find((s) => s.name === params.space);
    if (!target) throw new RpcError(`space not found: ${params.space}`, "space_not_found");
    const { ensureWindowForSpace } = await import("../../spaces");
    const windowId = await ensureWindowForSpace(target);
    return { windowId, spaceId: target.id, spaceName: target.name };
  }
  // Default: pick the currently focused window. Fall back to the first window.
  const windows = await chrome.windows.getAll();
  const focused = windows.find((w) => w.focused) ?? windows[0];
  if (!focused?.id) {
    const created = await chrome.windows.create({ url: "chrome://newtab" });
    if (!created?.id) throw new RpcError("could not create a window", "no_windows");
    return { windowId: created.id, spaceId: null, createdWindowId: created.id };
  }
  return { windowId: focused.id, spaceId: null };
}

/**
 * Dispatch an MCP task. Returns immediately with a task handle; the
 * host polls `task_status` for progress and the final output.
 *
 * The handler covers two paths:
 *
 *  - **Auto-confirmed:** Policy resolves to `auto`. We register the
 *    task as `running`, kick off `runMcpTask` fire-and-forget, return
 *    `{ status: "running", taskId }` immediately.
 *
 *  - **Prompt required:** Policy resolves to `prompt`. We register
 *    the task as `awaiting_confirmation`, spawn a detached promise
 *    that:
 *      1. Calls `awaitConfirmation` (this is where the user prompt
 *         is registered with the confirmation store; we capture the
 *         resulting promptId via a side channel — see below).
 *      2. On `allow`: marks the task `running`, kicks off the runner.
 *      3. On `deny` / host_blocked / auto-deny: marks the task
 *         `cancelled` (or `errored` for `host_blocked`).
 *    The handler returns `{ status: "awaiting_confirmation", taskId }`
 *    immediately.
 *
 * The promptId capture for the awaiting_confirmation case is
 * handled by `awaitConfirmation`'s notify hook: when it registers a
 * pending entry it calls into a registered taskId-keyed callback so
 * we can stash the promptId on the task row for `cancel_task`'s
 * dismiss-as-deny path. The callback is provided through
 * `awaitConfirmation`'s new `onPromptRegistered` arg.
 */
export async function handleTask(
  rawParams: unknown,
  ctx: {
    authContext: { sub: string; client_name?: string; scope?: string };
    emitEvent: (e: unknown) => void;
  },
): Promise<TaskResult> {
  const params = (rawParams ?? {}) as Partial<TaskParams>;
  if (typeof params.prompt !== "string" || params.prompt.trim().length === 0) {
    throw new RpcError("missing required parameter: prompt", "invalid_params");
  }

  const preflight = await preflightAgent();
  if (!preflight.ok) {
    throw new RpcError(preflight.message, preflight.code);
  }

  const { windowId, spaceId, spaceName, createdWindowId } = await resolveTargetWindow(
    params as TaskParams,
  );

  // Everything between here and `tasksStore.register` runs BEFORE
  // the task exists in the store, so a throw would orphan
  // `createdWindowId` (if we just materialised a window). The
  // startup sweep can't recover this: it walks chat-db conversations
  // and there's no conversation yet. Wrap in try/catch and close the
  // window on any error before rethrowing.
  let taskId: string;
  let controller: AbortController;
  let startedAt: number;
  let initialStatus: TaskStatus;
  let hostName: string;
  let activeTabUrl: string | undefined;
  let hostRequest: "auto" | "prompt";
  let policyOutcome: Awaited<
    ReturnType<typeof import("@/lib/mcp-host-policy").resolveConfirmation>
  >;
  try {
    const tabs = await chrome.tabs.query({ windowId, active: true });
    activeTabUrl = tabs[0]?.url;

    hostName = ctx.authContext.client_name ?? ctx.authContext.sub;
    const settings = await storage.getSettings();
    hostRequest =
      settings.mcpAlwaysConfirmTasks === true
        ? "prompt"
        : params.confirmation === "prompt"
        ? "prompt"
        : "auto";

    // Determine the policy outcome up front so we can decide whether
    // to register as `running` (auto-confirmed) or
    // `awaiting_confirmation` (prompt path). Reusing
    // `resolveConfirmation` here directly avoids registering a
    // pending entry just to inspect the outcome.
    const { resolveConfirmation } = await import("@/lib/mcp-host-policy");
    policyOutcome = await resolveConfirmation(
      ctx.authContext.sub,
      hostRequest,
    );
    if (policyOutcome === "host_blocked") {
      throw new RpcError(
        "host_blocked: this MCP host is blocked by user policy",
        "host_blocked",
      );
    }

    taskId = newTaskId();
    controller = new AbortController();
    startedAt = Date.now();
    initialStatus =
      policyOutcome === "auto" ? "running" : "awaiting_confirmation";
  } catch (e) {
    if (createdWindowId !== undefined) {
      try {
        await chrome.windows.remove(createdWindowId);
      } catch {
        // best-effort: window may already be gone.
      }
    }
    throw e;
  }

  tasksStore.register({
    taskId,
    clientId: ctx.authContext.sub,
    hostName,
    prompt: params.prompt,
    conversationId: "",
    targetWindowId: windowId,
    spaceId,
    createdWindowId,
    controller,
    startedAt,
    taskTitlePreview: params.prompt.slice(0, 40),
    status: initialStatus,
  });

  // Resolve task info for cleanup. Captured at registration so the
  // terminal branches can route through `runCleanupForTask` even
  // after `tasksStore` has marked the task terminal (the store row
  // may not reflect `createdWindowId` after mutations).
  //
  // `conversationId` is `null` until `runMcpTask` returns and we know
  // the chat-db row id. Early-error paths (preflight failure,
  // host_blocked, awaitConfirmation throw, runMcpTask throw before
  // the row is created) reach cleanup with `null` — the cleanup
  // runtime then skips the tab walk entirely and only removes
  // `createdWindowId`.
  const cleanupTaskInfo: {
    taskId: string;
    conversationId: string | null;
    createdWindowId: number | undefined;
  } = {
    taskId,
    conversationId: null,
    createdWindowId,
  };

  // The runner closure below is shared by both paths. It taps each
  // McpTaskEvent into progress fields on tasksStore so `task_status`
  // can return a useful hint, and accumulates text into `output` for
  // the final completion. Errors emitted by the runner override the
  // captured-error path.
  const runRunner = async () => {
    let accumulatedText = "";
    let lastError: string | null = null;
    const interceptingEmit = (e: McpTaskEvent) => {
      if (e.kind === "text" && typeof e.text === "string") {
        accumulatedText += e.text;
        // Intentionally do NOT update lastEvent on every text-delta:
        // a typical run emits dozens per turn, and pinning the
        // progress preview to "Wrote text" hides the actual tool
        // activity. The next step-start/step-finish will refresh the
        // line.
      } else if (e.kind === "error" && typeof e.message === "string") {
        lastError = e.message;
      } else if (e.kind === "step-start") {
        const summary = progressFromStepStart({
          toolName: e.toolName,
          argsPreview: e.argsPreview,
        });
        tasksStore.setProgress(taskId, {
          lastEvent: summary.lastEvent,
          stepCounter: e.step,
          ...(summary.currentUrl != null
            ? { currentUrl: summary.currentUrl }
            : {}),
        });
      } else if (e.kind === "step-finish") {
        const summary = progressFromStepFinish({ toolName: e.toolName });
        tasksStore.setProgress(taskId, {
          lastEvent: summary.lastEvent,
          stepCounter: e.step,
        });
      }
      ctx.emitEvent(e);
    };

    try {
      const control = await runMcpTask({
        taskId,
        clientId: ctx.authContext.sub,
        hostName,
        prompt: params.prompt!,
        targetWindowId: windowId,
        spaceId,
        abortSignal: controller.signal,
        emitEvent: interceptingEmit,
      });
      tasksStore.updateConversationId(taskId, control.conversationId);
      cleanupTaskInfo.conversationId = control.conversationId;
      await control.completion;

      // Terminal state — translate runner status into tasksStore.
      if (control.handle.status === "errored") {
        tasksStore.markErrored(taskId, {
          code: "agent_run_failed",
          message: lastError ?? "agent run errored without a diagnostic message",
        });
        void runCleanupForTask(cleanupTaskInfo, "errored");
      } else if (control.handle.status === "aborted") {
        // Aborted means either user cancelled (status already
        // `cancelled` in store) or external — fall back to cancelled.
        const current = tasksStore.get(taskId);
        if (current?.status !== "cancelled") {
          tasksStore.markCancelled(taskId);
        }
        void runCleanupForTask(cleanupTaskInfo, "cancelled");
      } else {
        tasksStore.markCompleted(taskId, accumulatedText);
        void runCleanupForTask(cleanupTaskInfo, "completed");
      }
    } catch (err) {
      // runMcpTask itself threw (factory failure, unexpected exception).
      const message = err instanceof Error ? err.message : String(err);
      tasksStore.markErrored(taskId, { code: "agent_run_failed", message });
      void runCleanupForTask(cleanupTaskInfo, "errored");
    }
  };

  if (policyOutcome === "auto") {
    // Fire-and-forget. The runner mutates tasksStore as it progresses;
    // `task_status` reflects the live state.
    void runRunner();
    return {
      taskId,
      conversationId: "",
      status: "running",
      startedAt,
    };
  }

  // Prompt path: spawn a detached awaiter. Returns immediately with
  // `awaiting_confirmation`.
  void (async () => {
    let outcome: "allow" | "deny";
    try {
      outcome = await awaitConfirmation({
        clientId: ctx.authContext.sub,
        hostName,
        prompt: params.prompt!,
        targetWindowInfo: { windowId, activeTabUrl, spaceName },
        hostRequest,
        // 2026-06-29 async dispatch: capture the promptId so
        // `cancel_task` can dismiss-as-deny if the host cancels
        // before the user decides.
        onPromptRegistered: (promptId) => {
          tasksStore.setPendingPromptId(taskId, promptId);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("host_blocked")) {
        tasksStore.markErrored(taskId, {
          code: "host_blocked",
          message: "this MCP host is blocked by user policy",
        });
      } else {
        tasksStore.markErrored(taskId, { code: "internal_error", message });
      }
      // No agent has run yet so there are no owned tabs — only
      // remove the fallback window we may have materialised.
      void runCleanupForTask(cleanupTaskInfo, "errored");
      return;
    }
    ctx.emitEvent({ kind: "user-confirmed", outcome });
    if (outcome === "deny") {
      tasksStore.markCancelled(taskId);
      void runCleanupForTask(cleanupTaskInfo, "cancelled");
      return;
    }
    tasksStore.setRunning(taskId);
    await runRunner();
  })();

  return {
    taskId,
    conversationId: "",
    status: "awaiting_confirmation",
    startedAt,
  };
}