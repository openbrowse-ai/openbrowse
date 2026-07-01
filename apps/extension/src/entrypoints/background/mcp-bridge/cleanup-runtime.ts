/**
 * MCP task tab/window cleanup — runtime layer.
 *
 * Imports chrome.* and chat-db lazily so the static import graph stays
 * narrow. Bundle-graph rationale: the settings page imports
 * `cleanup-policy.ts` (pure decision helpers) directly. This file (the
 * runtime caller) is imported only from the background entrypoint so
 * its lazy `await import()` calls are gated by call-site execution
 * rather than module-load time.
 *
 * Routed to from `handlers/task.ts`'s terminal branch
 * (completed/errored/cancelled) and from the SW-startup orphan sweep
 * (`sweepOrphanedMcpTasks`). The cancel-task RPC path does NOT call
 * cleanup directly — it triggers the runner's abort, which then routes
 * through `task.ts`'s aborted branch.
 *
 * Cleanup uses `closeOwnedTabs` (the canonical helper from
 * `tab-scoping.ts`) which:
 *   - removes tabs via `chrome.tabs.remove`
 *   - clears the in-memory `tabOwnership` map entries
 *   - updates the conversation's `ownedLtids` / `ownedGroupId` in
 *     chat-db
 *   - returns an undo payload we broadcast as `AGENT_TABS_CLOSED` so
 *     the Undo toast surfaces consistently with auto-tidy.
 *
 * Subagent-tab handling (A3 fix, 2026-06-30): when an MCP run spawns
 * subagents via `delegate`, each subagent gets its own conversation
 * row with its own `ownedLtids`. Cleanup walks the parent + every
 * descendant (recursively, depth-bounded by `MAX_DESCENDANT_DEPTH` for
 * defense-in-depth against a future cycle bug) and closes each row's
 * tabs. Without this walk every subagent leaks the tabs it opened.
 */

import {
  decideTabCleanup,
  resolveTabCleanupPolicy,
  type TabCleanupOutcome,
  type TabCleanupPolicy,
} from "./cleanup-policy";
import { tasksStore } from "../tasks-store";

export type { TabCleanupOutcome, TabCleanupPolicy } from "./cleanup-policy";
export {
  decideTabCleanup,
  resolveTabCleanupPolicy,
} from "./cleanup-policy";

/**
 * Undo payload shape — kept here as a structural type rather than
 * importing from `tab-scoping.ts` to keep the test surface
 * dependency-free.
 */
interface CloseTabsUndoLike {
  action: "reopen";
  id: string;
  tabs: { url: string; windowId: number; pinned: boolean }[];
}

/**
 * Dependencies for `cleanupTaskTabs`. Injected so the orchestrator
 * can be unit-tested without mocking chrome.tabs / chrome.windows /
 * chat-db / storage.
 *
 * Why lazy production imports (in `runCleanupForTask`): keeps the
 * static import graph of this module narrow so the SW bundle isn't
 * forced to materialise chat-db / tab-scoping / storage until cleanup
 * actually fires. Also keeps test setup cheap (tests inject fakes
 * without touching the production modules).
 */
export interface CleanupTaskTabsDeps {
  /** Read the effective settings. */
  getSettings(): Promise<{
    mcpAfterTaskTabPolicy?: TabCleanupPolicy;
    mcpKeepTabsAfterCancel?: boolean;
  }>;
  /** Resolve the conversation's `ownedLtids`. Empty array if unknown. */
  getConversationOwnedLtids(conversationId: string): Promise<string[]>;
  /**
   * Resolve every descendant (subagent) conversation id transitively.
   * Used to walk the subagent tree and close THEIR tabs too. Returns
   * an empty array if the root has no children or is unknown.
   *
   * Depth is bounded by the caller (`cleanupTaskTabs` enforces a hard
   * cap) so a hypothetical cycle in chat-db would not loop forever.
   */
  listDescendantConversationIds(rootConversationId: string): Promise<string[]>;
  /** Close the tabs and return the undo payload. */
  closeOwnedTabs(
    conversationId: string,
    ltids: string[],
  ): Promise<CloseTabsUndoLike>;
  /** Broadcast a runtime message (typically `AGENT_TABS_CLOSED`). */
  broadcast(message: unknown): Promise<unknown>;
  /** Remove a Chrome window. */
  removeWindow(windowId: number): Promise<void>;
}

/**
 * Information about the task we're cleaning up. Kept narrow so
 * `cleanupTaskTabs` only depends on what it actually uses.
 *
 * `conversationId` can be `null` for early-error paths where the
 * runner never reached the `runMcpTask` call (e.g. awaitConfirmation
 * threw before any agent run). In that case there is no conversation
 * to walk and only `createdWindowId` cleanup applies.
 */
export interface CleanupTaskTabsTaskInfo {
  taskId: string;
  conversationId: string | null;
  /**
   * If the bridge created a Chrome window for this task (fallback
   * path in `resolveTargetWindow` when no windows existed), it's
   * recorded here so cleanup can close it. Undefined for tasks that
   * targeted a pre-existing window or a Space's persistent window.
   */
  createdWindowId?: number;
}

/**
 * Run terminal-state cleanup for an MCP task. Idempotent and
 * best-effort — every internal failure is swallowed because cleanup
 * runs after the host has already received its terminal response;
 * surfacing an error here would do nothing useful.
 *
 * Behaviour:
 *  1. Read policy from settings; resolve via `resolveTabCleanupPolicy`
 *     (handles the legacy `mcpKeepTabsAfterCancel` migration).
 *  2. Consult `decideTabCleanup(policy, outcome)`. If false, return
 *     immediately — the user has opted out of cleanup for this
 *     outcome.
 *  3. If `task.conversationId` is non-null, walk the parent + every
 *     descendant subagent conversation. For each row with non-empty
 *     `ownedLtids`, call `closeOwnedTabs` and broadcast the undo. We
 *     accumulate one broadcast per row that closed tabs (the side
 *     panel's Undo handler keys by conversationId, so distinct
 *     broadcasts are correct — a single coalesced broadcast would
 *     attribute the undo to the wrong conversation).
 *  4. If `task.createdWindowId` is set, also remove that window —
 *     even if there were no owned tabs (a window we materialised but
 *     never used is still ours to clean up).
 *
 *  Mid-run `closeTabs` race: the agent may auto-approve and execute
 *  `closeTabs` while still running. That call mutates the
 *  conversation's `ownedLtids` directly via `closeOwnedTabs`. When
 *  cleanup later fires, `getConversationOwnedLtids` returns the
 *  post-mutation array — correct behaviour: tabs the agent has
 *  already closed are not double-closed; tabs it left open are.
 *  This relies on `closeOwnedTabs` being the sole writer to
 *  `ownedLtids` and on its mutation being awaited before the run
 *  terminates, both of which hold in the current codebase.
 */
export async function cleanupTaskTabs(
  task: CleanupTaskTabsTaskInfo,
  outcome: TabCleanupOutcome,
  deps: CleanupTaskTabsDeps,
): Promise<void> {
  try {
    const settings = await deps.getSettings();
    const policy = resolveTabCleanupPolicy(settings);
    if (!decideTabCleanup(policy, outcome)) return;

    // Step 1: walk the conversation tree (parent + every descendant
    // subagent) and close each row's owned tabs. Skip entirely when
    // there's no conversationId (early-error path before any agent
    // run; nothing to walk).
    if (task.conversationId != null && task.conversationId.length > 0) {
      const rowsToClean = await collectRowsToClean(task.conversationId, deps);
      for (const cid of rowsToClean) {
        try {
          const ltids = await deps.getConversationOwnedLtids(cid);
          if (ltids.length === 0) continue;
          const undo = await deps.closeOwnedTabs(cid, ltids);
          try {
            await deps.broadcast({
              type: "AGENT_TABS_CLOSED",
              conversationId: cid,
              undo,
            });
          } catch {
            // No listener (side panel closed); the close already happened.
          }
        } catch {
          // closeOwnedTabs / getConversationOwnedLtids failure for ONE
          // row shouldn't block cleanup of sibling rows.
        }
      }
    }

    // Step 2: window we created for this task. Independent of tab
    // cleanup because a window we created but didn't open tabs in is
    // still ours to remove.
    if (typeof task.createdWindowId === "number") {
      try {
        await deps.removeWindow(task.createdWindowId);
      } catch {
        // Window already gone or unremovable; fine.
      }
    }
  } catch {
    // Outermost defensive catch — never throw from cleanup.
  }
}

/**
 * Hard cap on descendant walk depth. Defense-in-depth against a
 * hypothetical cycle in chat-db's `parentConversationId` graph (the
 * subagent runner enforces a depth of 1 today, so any tree has at
 * most 2 levels — but cleanup shouldn't trust that invariant). 8 is
 * arbitrary; deep enough for any plausible legitimate tree.
 */
const MAX_DESCENDANT_DEPTH = 8;

/**
 * Pure helper, exported for unit testing: build the deduplicated list
 * of conversation ids whose tabs should be closed during cleanup
 * (root + every descendant up to MAX_DESCENDANT_DEPTH).
 */
export async function collectRowsToClean(
  rootConversationId: string,
  deps: Pick<CleanupTaskTabsDeps, "listDescendantConversationIds">,
): Promise<string[]> {
  const seen = new Set<string>([rootConversationId]);
  const queue: { id: string; depth: number }[] = [
    { id: rootConversationId, depth: 0 },
  ];
  const ordered: string[] = [rootConversationId];
  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= MAX_DESCENDANT_DEPTH) continue;
    let children: string[];
    try {
      children = await deps.listDescendantConversationIds(id);
    } catch {
      continue;
    }
    for (const child of children) {
      if (seen.has(child)) continue; // dedupe + cycle break
      seen.add(child);
      ordered.push(child);
      queue.push({ id: child, depth: depth + 1 });
    }
  }
  return ordered;
}

/**
 * Production-wired cleanup. Constructs real `CleanupTaskTabsDeps`
 * from the production modules and delegates to `cleanupTaskTabs`.
 * Callers use this; tests use `cleanupTaskTabs` directly with
 * injected deps.
 */
export async function runCleanupForTask(
  task: CleanupTaskTabsTaskInfo,
  outcome: TabCleanupOutcome,
): Promise<void> {
  await cleanupTaskTabs(task, outcome, productionDeps());
}

/**
 * Lazy-import factory for the production deps. Exported for the
 * SW-startup orphan sweep, which also needs to invoke
 * `cleanupTaskTabs` directly.
 */
export function productionDeps(): CleanupTaskTabsDeps {
  return {
    async getSettings() {
      const { storage } = await import("@/lib/storage");
      return storage.getSettings();
    },
    async getConversationOwnedLtids(conversationId) {
      const { chatDb } = await import("@/lib/chat-db");
      const conv = await chatDb.getConversation(conversationId);
      return conv?.ownedLtids ?? [];
    },
    async listDescendantConversationIds(rootConversationId) {
      // The chat-db `by-parent` index makes this an O(children) lookup
      // per call. Cleanup runs once per task terminal so the cost is
      // bounded by the subagent tree size (today: ≤ depth 1).
      const { chatDb } = await import("@/lib/chat-db");
      const children = await chatDb.listChildren(rootConversationId);
      return children.map((c) => c.id);
    },
    async closeOwnedTabs(conversationId, ltids) {
      const { closeOwnedTabs } = await import("../tab-scoping");
      return closeOwnedTabs(conversationId, ltids);
    },
    async broadcast(message) {
      return chrome.runtime.sendMessage(message);
    },
    async removeWindow(windowId) {
      await chrome.windows.remove(windowId);
    },
  };
}

/**
 * SW-startup orphan sweep (A6 fix, 2026-06-30).
 *
 * When the SW restarts mid-MCP-task, `tasksStore` is in-memory and
 * the row vanishes; the host has already received (or never will
 * receive) its terminal response; the conversation's `ownedLtids`
 * persist in chat-db with no live runner to clean them. Without a
 * boot-time sweep, those tabs leak forever.
 *
 * Strategy:
 *  - Read every conversation with `source === "mcp"` from chat-db.
 *  - Skip rows whose corresponding `tasksStore` entry is still
 *    `running` or `awaiting_confirmation` (a live runner will reach
 *    terminal cleanup on its own).
 *  - For each remaining row, treat the run as "completed" for policy
 *    purposes and route through `cleanupTaskTabs`. The policy gate
 *    is consulted normally so a user who picked `"keep"` is honoured.
 *
 *  Subagent rows are NOT sweep roots: they're walked transitively by
 *  `collectRowsToClean` when the parent is swept. Sweeping a
 *  subagent independently would either (a) duplicate cleanup with
 *  the parent's sweep, or (b) leak the parent's tabs if the
 *  subagent walked alone. We only sweep parent MCP rows
 *  (`parentConversationId == null`) and let the descendant walk
 *  handle the children.
 *
 *  Idempotent: re-running the sweep after partial cleanup is safe.
 *  `closeOwnedTabs` is a no-op on rows with empty `ownedLtids` (which
 *  is the post-cleanup state).
 */
export async function sweepOrphanedMcpTasks(opts?: {
  /**
   * Filter to determine if a conversationId is "live" — i.e. has an
   * active runner that will reach its own terminal cleanup. Defaults
   * to checking `tasksStore` for a non-terminal row. Exported for
   * testing.
   */
  isLive?: (conversationId: string) => boolean;
  deps?: CleanupTaskTabsDeps;
}): Promise<{ swept: string[]; skipped: string[] }> {
  const deps = opts?.deps ?? productionDeps();
  const isLive = opts?.isLive ?? defaultIsLive;

  const { chatDb } = await import("@/lib/chat-db");
  // Walk every MCP root conversation. Sweep only depth=0 rows
  // (parentConversationId == null); descendants are handled by
  // `collectRowsToClean` when the parent is swept.
  const candidates = await chatDb.listMcpConversations();

  const swept: string[] = [];
  const skipped: string[] = [];
  for (const conv of candidates) {
    if (isLive(conv.id)) {
      skipped.push(conv.id);
      continue;
    }
    try {
      await cleanupTaskTabs(
        {
          taskId: `orphan-sweep:${conv.id}`,
          conversationId: conv.id,
          // We don't know what (if any) Chrome window the bridge
          // created for this run — that data lives only in the
          // in-memory tasksStore which is gone after SW restart.
          // Leaving createdWindowId undefined means we close tabs
          // but don't close the window. Pragmatic — preserves any
          // user-visible state in the window that the dead task
          // didn't own.
          createdWindowId: undefined,
        },
        // Treat the orphan as "completed" for policy purposes. We
        // can't know what its actual terminal status was, so we pick
        // the outcome that best matches user intent under each
        // supported policy:
        //   - `always-close`: closes → matches "clean up".
        //   - `keep`: keeps → matches "never touch my tabs".
        //   - `close-on-cancel-only`: keeps → matches "only close
        //     when I explicitly cancelled." An SW-death orphan is NOT
        //     a user cancel, so leaving the tabs alone respects the
        //     intent. (Using `errored` or `cancelled` here would
        //     over-close for users on this policy.)
        "completed",
        deps,
      );
      swept.push(conv.id);
    } catch {
      // Best-effort.
    }
  }
  return { swept, skipped };
}

function defaultIsLive(conversationId: string): boolean {
  for (const t of tasksStore.list()) {
    if (
      t.conversationId === conversationId &&
      (t.status === "running" || t.status === "awaiting_confirmation")
    ) {
      return true;
    }
  }
  return false;
}
