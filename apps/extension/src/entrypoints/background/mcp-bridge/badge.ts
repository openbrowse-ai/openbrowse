/**
 * Toolbar badge driven by bridge state.
 *
 * Three independent inputs combine into a single badge with a strict
 * priority order:
 *
 *   1. `awaiting_tofu`          → amber `!`
 *   2. `key_mismatch`           → red `!`
 *   3. `pending_prompts > 0`    → blue `<count>`
 *   4. `active_tasks > 0`       → blue `·`
 *   5. otherwise                → clear
 *
 * (1) and (2) are visual alerts the user must resolve in Settings →
 * MCP Server. (3) and (4) are informational: a numeric count tells
 * the user the SW is waiting on them; a single dot tells them
 * something is happening in the background without demanding
 * attention.
 *
 * The watcher subscribes to all three emitters and keeps a tiny piece
 * of local state for the inputs other than the one that just fired,
 * so each callback can recompute the badge without re-reading the
 * stores.
 */

import { onStatusChange, getStatus } from "./boot";
import {
  listPendingPrompts,
  onPromptsChange,
  type PendingPrompt,
} from "./confirmation";
import type { BridgeStatus } from "./status";
import { onTasksChange, tasksStore, type ActiveTask } from "../tasks-store";

const AMBER = "#f59e0b";
const RED = "#ef4444";
const BLUE = "#2563eb";

const TITLES: Record<BridgeStatus["kind"], string> = {
  disconnected: "OpenBrowse — MCP server disconnected",
  connecting: "OpenBrowse — connecting to MCP helper…",
  awaiting_tofu: "OpenBrowse — new MCP helper awaiting your trust (open Settings)",
  key_mismatch: "OpenBrowse — MCP helper key changed (open Settings)",
  connected: "OpenBrowse",
};

/**
 * Pure helper, exported for unit testing. Computes the
 * `chrome.action` mutations that should be applied for a given
 * combined state.
 *
 * Output uses `color: null` and `text: ""` for the cleared badge so
 * callers can branch on either field; the title is always set.
 */
export function badgeUpdateFor(args: {
  status: BridgeStatus;
  pendingPromptCount: number;
  activeTaskCount: number;
}): { text: string; color: string | null; title: string } {
  const { status, pendingPromptCount, activeTaskCount } = args;
  switch (status.kind) {
    case "awaiting_tofu":
      return { text: "!", color: AMBER, title: TITLES.awaiting_tofu };
    case "key_mismatch":
      return { text: "!", color: RED, title: TITLES.key_mismatch };
    case "disconnected":
    case "connecting":
    case "connected":
      // No connection alert pending. Surface MCP activity next.
      if (pendingPromptCount > 0) {
        return {
          text: String(Math.min(pendingPromptCount, 99)),
          color: BLUE,
          title: `OpenBrowse — ${pendingPromptCount} MCP confirmation${
            pendingPromptCount === 1 ? "" : "s"
          } awaiting your decision`,
        };
      }
      if (activeTaskCount > 0) {
        return {
          text: "·",
          color: BLUE,
          title: `OpenBrowse — ${activeTaskCount} MCP task${
            activeTaskCount === 1 ? "" : "s"
          } running in the background`,
        };
      }
      return { text: "", color: null, title: TITLES[status.kind] };
  }
}

/**
 * Subscribe the toolbar badge to all three emitter sources.
 * Idempotent caller responsibility — invoke once during SW boot.
 *
 * Returns a teardown function that unsubscribes from every source.
 * The SW never calls it in production (badge lives for SW lifetime),
 * but tests use it to detach between cases.
 */
export function attachBadgeWatcher(): () => void {
  // Module-local mirror of each input. Snapshotted on first attach
  // so a fresh SW boot lands the badge in the correct initial state
  // even before any of the three emitters fire.
  let status: BridgeStatus = getStatus();
  let pendingPrompts: PendingPrompt[] = listPendingPrompts();
  let activeTasks: ActiveTask[] = tasksStore.list();

  function apply(): void {
    const update = badgeUpdateFor({
      status,
      pendingPromptCount: pendingPrompts.length,
      activeTaskCount: activeTasks.length,
    });
    try {
      chrome.action.setBadgeText({ text: update.text });
    } catch {
      // No-op when chrome.action is unavailable (tests omit it).
    }
    if (update.color != null) {
      try {
        chrome.action.setBadgeBackgroundColor({ color: update.color });
      } catch {
        // No-op.
      }
    }
    try {
      chrome.action.setTitle({ title: update.title });
    } catch {
      // No-op.
    }
  }

  // Apply the initial badge state synchronously.
  apply();

  const unsubStatus = onStatusChange((s) => {
    status = s;
    apply();
  });
  const unsubPrompts = onPromptsChange((p) => {
    pendingPrompts = p;
    apply();
  });
  const unsubTasks = onTasksChange((t) => {
    activeTasks = t;
    apply();
  });

  return () => {
    unsubStatus();
    unsubPrompts();
    unsubTasks();
  };
}
