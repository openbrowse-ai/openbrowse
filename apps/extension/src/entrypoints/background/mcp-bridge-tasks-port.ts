/**
 * Service-worker side of the tasks push channel.
 *
 * The Settings → MCP Server → Activity surface opens a long-lived
 * `chrome.runtime.connect` port named `mcp-bridge:tasks`. We send a
 * sanitised snapshot of every known task (live + terminal-within-TTL)
 * on connect and on every mutation.
 *
 * Sanitisation: the raw `ActiveTask` row carries an `AbortController`
 * (non-serialisable) and the `clientId` (sensitive — the OAuth subject;
 * shouldn't bleed to the UI). We strip both and emit only the fields
 * the Activity view actually renders.
 */

import { tasksStore, onTasksChange, type ActiveTask, type TaskStatus } from "./tasks-store";

export const TASKS_PORT_NAME = "mcp-bridge:tasks";

export interface ActiveTaskPublicSummary {
  taskId: string;
  hostName: string;
  prompt: string;
  /**
   * Chat-db conversation id, or `null` during the brief window
   * between `tasksStore.register` and the runner calling
   * `updateConversationId`. The Settings UI treats `null` as the
   * "not yet available — don't render as clickable" signal so the
   * deep-link button only appears once the destination exists.
   */
  conversationId: string | null;
  targetWindowId: number;
  spaceId: string | null;
  startedAt: number;
  taskTitlePreview: string | null;
  // ── Async-dispatch fields (2026-06-29) ──────────────────────────
  status: TaskStatus;
  endedAt: number | null;
  /** Short hint of last progress event. Null if none yet. */
  lastEvent: string | null;
  /**
   * Best-effort URL the agent is currently working on. Null if not
   * known yet (e.g. before the first navigate-style tool call).
   * Truncated to 500 chars by the store.
   */
  currentUrl: string | null;
}

export interface TasksTickMessage {
  type: "MCP_BRIDGE_TASKS_TICK";
  tasks: ActiveTaskPublicSummary[];
}

/**
 * Sanitise an `ActiveTask` for the wire. Pure helper, exported for
 * unit testing.
 */
export function toPublicSummary(t: ActiveTask): ActiveTaskPublicSummary {
  return {
    taskId: t.taskId,
    hostName: t.hostName,
    prompt: t.prompt,
    conversationId:
      t.conversationId.length > 0 ? t.conversationId : null,
    targetWindowId: t.targetWindowId,
    spaceId: t.spaceId ?? null,
    startedAt: t.startedAt,
    taskTitlePreview: t.taskTitlePreview ?? null,
    status: t.status,
    endedAt: t.endedAt ?? null,
    lastEvent: t.lastEvent ?? null,
    currentUrl: t.currentUrl ?? null,
  };
}

/**
 * Register the `onConnect` listener for the tasks port. Invoke once
 * per SW lifetime from `background/index.ts`.
 */
export function attachTasksPort(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== TASKS_PORT_NAME) return;

    try {
      port.postMessage(makeTick(tasksStore.list()));
    } catch {
      return;
    }

    const unsubscribe = onTasksChange((snapshot) => {
      try {
        port.postMessage(makeTick(snapshot));
      } catch {
        // ignore; onDisconnect will clean up.
      }
    });

    port.onDisconnect.addListener(() => {
      unsubscribe();
    });
  });
}

function makeTick(tasks: ActiveTask[]): TasksTickMessage {
  return {
    type: "MCP_BRIDGE_TASKS_TICK",
    tasks: tasks.map(toPublicSummary),
  };
}
