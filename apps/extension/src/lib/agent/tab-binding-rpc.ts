/**
 * Realm-aware bridge for the tab-binding RPCs that the agent-transport
 * tool wrappers used to send via `chrome.runtime.sendMessage` to the SW
 * background listeners (`BIND_TABS_TO_CONVERSATION` /
 * `BIND_ACTIVE_TAB_TO_CONVERSATION`).
 *
 * Under SW-host the agent-transport runs inside the SW, so the
 * `sendMessage` would not reach the SW's own listeners. This helper
 * invokes the same underlying `bindTabsToConversation` in-process in
 * the SW realm and falls back to `chrome.runtime.sendMessage` from
 * renderer realms.
 *
 * Both helpers swallow errors the same way the original inlined calls
 * did — the agent flow treats this binding as best-effort and rebuilds
 * its tab handles from chatDb on the next turn if the binding fails.
 */

import { isServiceWorkerContext } from "@/lib/runtime/context";

async function bindInSw(
  conversationId: string,
  tabIds: number[],
): Promise<void> {
  try {
    const [{ bindTabsToConversation }, { maybeGenerateGroupLabel }] =
      await Promise.all([
        import("@/entrypoints/background/tab-scoping"),
        import("@/entrypoints/background/group-label"),
      ]);
    const result = await bindTabsToConversation(conversationId, tabIds);
    if (result.groupId != null) {
      // Same fire-and-forget as the listener; never block the agent's
      // path on label generation.
      maybeGenerateGroupLabel(conversationId, result.groupId).catch(() => {});
    }
  } catch {
    // Best-effort; background may be wedged. Next-turn rebuild covers it.
  }
}

export async function bindTabsRPC(
  conversationId: string,
  tabIds: number[],
): Promise<void> {
  if (isServiceWorkerContext()) {
    return bindInSw(conversationId, tabIds);
  }
  try {
    await chrome.runtime.sendMessage({
      type: "BIND_TABS_TO_CONVERSATION",
      conversationId,
      tabIds,
    });
  } catch {
    // Background asleep; rebuilds on next startup.
  }
}

export async function bindActiveTabRPC(
  conversationId: string,
  tabId: number,
): Promise<void> {
  if (isServiceWorkerContext()) {
    // The SW listener treats this as a single-tab variant of
    // BIND_TABS_TO_CONVERSATION. Mirror that here.
    return bindInSw(conversationId, [tabId]);
  }
  try {
    await chrome.runtime.sendMessage({
      type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
      conversationId,
      tabId,
    });
  } catch {
    // Background asleep; rebuilds on next startup.
  }
}
