import { chatDb } from "@/lib/chat-db";
import { tabRegistry, type LogicalTabId } from "@/lib/agent/tab-registry";

/**
 * In-memory ownership maps. As of the LogicalTabId migration:
 *
 *  - `tabOwnership` is keyed on `LogicalTabId` (UUID) so a `chrome.tabs
 *    .onReplaced` (Speculation Rules / prerender activation) doesn't
 *    silently corrupt ownership — the ltid stays the same across the
 *    swap; only the underlying ctid changes (and that change is handled
 *    by the registry itself).
 *  - `groupOwnership` stays keyed on `groupId` — group ids ARE stable
 *    across replacements (Chrome moves the new tab into the existing
 *    group automatically).
 *  - `userOpenedSidePanelTabs` and `agent_toast_dismissed_tabs` stay
 *    keyed on chrome tab id: they represent UX gestures against a
 *    specific tab right now ("the user just opened the side panel here"),
 *    not logical agent identity.
 */
const tabOwnership = new Map<LogicalTabId, string>();
const groupOwnership = new Map<number, string>();
const sidePanelOpenByWindow = new Map<number, boolean>();

// Tabs the user explicitly opened the side panel on. Ephemeral (cleared on
// extension reload). Chrome 141+ onOpened/onClosed syncs this automatically;
// older versions rely on explicit helper calls on gesture.
const userOpenedSidePanelTabs = new Set<number>();

export function markUserOpenedSidePanel(tabId: number) {
  userOpenedSidePanelTabs.add(tabId);
}

export function markUserClosedSidePanel(tabId: number) {
  userOpenedSidePanelTabs.delete(tabId);
}

export function isUserOpenedSidePanel(tabId: number): boolean {
  return userOpenedSidePanelTabs.has(tabId);
}

const DISMISSED_STORAGE_KEY = "agent_toast_dismissed_tabs";

async function getDismissedTabs(): Promise<Set<number>> {
  try {
    const result = await chrome.storage.session.get(DISMISSED_STORAGE_KEY);
    const list = result[DISMISSED_STORAGE_KEY];
    if (Array.isArray(list)) return new Set(list as number[]);
  } catch {}
  return new Set();
}

async function setDismissedTabs(set: Set<number>): Promise<void> {
  try {
    await chrome.storage.session.set({
      [DISMISSED_STORAGE_KEY]: Array.from(set),
    });
  } catch {}
}

export async function markToastDismissed(tabId: number): Promise<void> {
  const dismissed = await getDismissedTabs();
  dismissed.add(tabId);
  await setDismissedTabs(dismissed);
}

export async function clearToastDismissalForTab(tabId: number): Promise<void> {
  const dismissed = await getDismissedTabs();
  if (dismissed.delete(tabId)) await setDismissedTabs(dismissed);
}

export async function clearToastDismissalForConversation(
  conversationId: string,
): Promise<void> {
  // Resolve each owned ltid to its current ctid for the dismissal store
  // (which is keyed on ctid by design — see tabOwnership comment above).
  const ctids: number[] = [];
  for (const [ltid, cid] of tabOwnership) {
    if (cid !== conversationId) continue;
    const ctid = tabRegistry.toChromeTabId(ltid);
    if (ctid != null) ctids.push(ctid);
  }
  if (ctids.length === 0) return;
  const dismissed = await getDismissedTabs();
  let changed = false;
  for (const ctid of ctids) {
    if (dismissed.delete(ctid)) changed = true;
  }
  if (changed) await setDismissedTabs(dismissed);
  for (const ctid of ctids) {
    chrome.tabs
      .get(ctid)
      .then((tab) => {
        if (tab.active && !isSidePanelOpenForWindow(tab.windowId!)) {
          emitToast(ctid, true);
        }
      })
      .catch(() => {});
  }
}

type ToastSubscriber = (tabId: number, show: boolean) => void;
const toastSubscribers = new Set<ToastSubscriber>();

type FocusSubscriber = (windowId: number, conversationId: string | null) => void;
const focusSubscribers = new Set<FocusSubscriber>();

export function onToastStateChange(fn: ToastSubscriber): () => void {
  toastSubscribers.add(fn);
  return () => toastSubscribers.delete(fn);
}

export function onFocusConversation(fn: FocusSubscriber): () => void {
  focusSubscribers.add(fn);
  return () => focusSubscribers.delete(fn);
}

async function emitToast(tabId: number, show: boolean) {
  if (show) {
    const dismissed = await getDismissedTabs();
    if (dismissed.has(tabId)) return;
  }
  for (const sub of toastSubscribers) {
    try { sub(tabId, show); } catch {}
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "OVERLAY_TOAST_STATE",
      show,
    });
  } catch {
    // Content script may not be loaded on this page (chrome://).
  }
}

function emitFocus(windowId: number, conversationId: string | null) {
  for (const sub of focusSubscribers) {
    try { sub(windowId, conversationId); } catch {}
  }
}

/**
 * Public lookup: which conversation owns the chrome tab id `tabId`?
 *
 * Keeps the legacy ctid-keyed signature so the dozen callers in
 * `background/index.ts` don't have to change. Internally resolves
 * ctid → ltid via the registry; returns `null` if the tab isn't tracked.
 */
export function getConversationForTab(tabId: number): string | null {
  const ltid = tabRegistry.toLogicalTabId(tabId);
  if (!ltid) return null;
  return tabOwnership.get(ltid) ?? null;
}

/**
 * Reverse lookup: all live chrome tab ids currently owned by a conversation.
 * Used to resolve which browser window a conversation lives in (e.g.
 * routing a notification click to the correct space's side panel).
 *
 * Resolves each owned ltid through the registry; ltids whose ctid the
 * registry can't resolve are dropped (the underlying tab is gone or hasn't
 * been re-discovered post-SW-restart).
 */
export function getTabsForConversation(conversationId: string): number[] {
  const tabIds: number[] = [];
  for (const [ltid, cid] of tabOwnership) {
    if (cid !== conversationId) continue;
    const ctid = tabRegistry.toChromeTabId(ltid);
    if (ctid != null) tabIds.push(ctid);
  }
  return tabIds;
}

export function getConversationForGroup(groupId: number): string | null {
  return groupOwnership.get(groupId) ?? null;
}

export function isTabOwned(tabId: number): boolean {
  const ltid = tabRegistry.toLogicalTabId(tabId);
  if (!ltid) return false;
  return tabOwnership.has(ltid);
}

export async function registerOwnership(
  conversationId: string,
  groupId: number,
  tabIds: number[],
): Promise<void> {
  groupOwnership.set(groupId, conversationId);
  for (const tabId of tabIds) {
    const ltid = tabRegistry.registerExisting(tabId);
    tabOwnership.set(ltid, conversationId);
    setPanelEnabledForTab(tabId, true);
  }
}

export function setSidePanelOpen(windowId: number, open: boolean) {
  sidePanelOpenByWindow.set(windowId, open);
  if (open) {
    chrome.tabs.query({ windowId, active: true }).then(([tab]) => {
      if (tab?.id != null) emitToast(tab.id, false);
    });
  } else {
    chrome.tabs.query({ windowId, active: true }).then(([tab]) => {
      if (tab?.id != null && isTabOwned(tab.id)) emitToast(tab.id, true);
    });
  }
}

export function isSidePanelOpenForWindow(windowId: number): boolean {
  return sidePanelOpenByWindow.get(windowId) ?? false;
}

export function applyDesiredPanelState(tabId: number) {
  // A tab should have the side panel registered (and enabled) if it's owned
  // by a conversation (agent is active in the group) OR the user explicitly
  // opened it there. Otherwise, leave it unregistered so Chrome shows
  // nothing on that tab. The manifest declares no global side panel, so
  // there's no default fallback to fight against.
  const owned = isTabOwned(tabId);
  const userOpened = userOpenedSidePanelTabs.has(tabId);
  chrome.sidePanel
    .setOptions({ tabId, path: "sidepanel.html", enabled: owned || userOpened })
    .catch(() => {});
}

async function setPanelEnabledForTab(tabId: number, enabled: boolean) {
  try {
    if (enabled) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: "sidepanel.html",
        enabled: true,
      });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
    }
  } catch {
    // Some tabs (chrome://, devtools) reject setOptions — safe to ignore.
  }
}

/**
 * Bind a list of chrome tabs to a conversation. Mints (or recovers) a
 * LogicalTabId for each ctid via the registry, then writes ltids to
 * `tabOwnership` and persists them to chatDb's `ownedLtids` field.
 *
 * Public API keeps the ctid signature so the message-bus handlers in
 * `background/index.ts` (which only know ctids when a tool calls
 * `BIND_TABS_TO_CONVERSATION`) don't need to know about ltids.
 */
export async function bindTabsToConversation(
  conversationId: string,
  tabIds: number[],
): Promise<{ groupId: number | null; boundTabIds: number[] }> {
  const tabs = await Promise.all(
    tabIds.map((id) => chrome.tabs.get(id).catch(() => null)),
  );
  const groupable = tabs.filter(
    (t): t is chrome.tabs.Tab => !!t && t.id != null && !t.pinned,
  );
  if (groupable.length === 0) return { groupId: null, boundTabIds: [] };

  const conv = await chatDb.getConversation(conversationId);
  if (!conv) return { groupId: null, boundTabIds: [] };

  const existingGroupId = conv.ownedGroupId;
  const ids = groupable.map((t) => t.id!) as [number, ...number[]];

  let groupId: number;
  try {
    groupId = await chrome.tabs.group(
      existingGroupId != null
        ? { tabIds: ids, groupId: existingGroupId }
        : { tabIds: ids },
    );
  } catch {
    return { groupId: null, boundTabIds: [] };
  }

  // For brand-new groups, set an immediate placeholder title so the
  // group is never nameless while the async LLM-based labeler runs.
  // The labeler later overwrites this with a 2-4 word label via
  // `maybeGenerateGroupLabel`; both call sites format through
  // `buildGroupTitle` so MCP / subagent / user prefixes are
  // consistent across placeholder and post-label states.
  if (existingGroupId == null) {
    const { buildGroupTitle } = await import("./group-title");
    let placeholder: string;
    if (conv.source === "mcp") {
      // MCP runs show a "MCP · " tag so the user can tell at a glance
      // which groups were created by an external host.
      placeholder = buildGroupTitle({
        source: "mcp",
        title: conv.title ?? "",
        labelLength: 14,
      });
    } else if (conv.parentConversationId) {
      const parent = await chatDb.getConversation(conv.parentConversationId);
      placeholder = buildGroupTitle({
        source: "subagent",
        title: conv.title ?? "",
        parentTitle: parent?.title ?? "",
        subagentSlug: conv.subagentSlug ?? "",
        labelLength: 20,
      });
    } else {
      placeholder = buildGroupTitle({
        source: "user",
        title: conv.title ?? "",
        labelLength: 20,
      });
    }
    chrome.tabGroups
      .update(groupId, { title: placeholder, color: "grey" })
      .catch(() => {
        // Group may have been dissolved mid-flight; ignore.
      });
  }

  groupOwnership.set(groupId, conversationId);
  // Mint or recover an ltid for each newly-bound ctid; merge with the
  // conversation's existing ownedLtids set.
  const newOwned = new Set<LogicalTabId>(conv.ownedLtids);
  for (const ctid of ids) {
    const ltid = tabRegistry.registerExisting(ctid);
    tabOwnership.set(ltid, conversationId);
    newOwned.add(ltid);
    setPanelEnabledForTab(ctid, true);
    clearToastDismissalForTab(ctid);
  }

  await chatDb.updateConversation(conversationId, {
    ownedGroupId: groupId,
    ownedLtids: Array.from(newOwned),
  });

  return { groupId, boundTabIds: ids };
}

/**
 * Drop ownership for a single ltid. Called from the registry's `onRemove`
 * subscription (the deduped stream — Chrome's trailing `onRemoved` after
 * `onReplaced` is suppressed there) and from the in-process `chrome.tabs
 * .onUpdated` group-change branch.
 */
async function clearTabOwnershipForLtid(ltid: LogicalTabId): Promise<void> {
  const convId = tabOwnership.get(ltid);
  if (!convId) return;
  tabOwnership.delete(ltid);

  // Best-effort: resolve the ltid back to its current ctid for the side-
  // panel state and toast updates. If the registry no longer has the
  // mapping (already dropped by `onRemove`), skip the UI updates — there's
  // no live tab to update anyway.
  const ctid = tabRegistry.toChromeTabId(ltid);
  if (ctid != null) {
    applyDesiredPanelState(ctid);
    emitToast(ctid, false);
  }

  const conv = await chatDb.getConversation(convId);
  if (!conv) return;
  const nextOwned = conv.ownedLtids.filter((l) => l !== ltid);
  // When the last owned tab is dropped, the group is also empty; null
  // `ownedGroupId` and clear the in-memory groupOwnership entry so a
  // future `bindTabsToConversation` mints a fresh group rather than
  // re-using a stale id. Without this, the conversation row could be
  // left in an inconsistent state (`ownedGroupId: 7, ownedLtids: []`)
  // until the next SW restart's reconciliation fixed it.
  const updates: { ownedLtids: typeof nextOwned; ownedGroupId?: number | null } = {
    ownedLtids: nextOwned,
  };
  if (nextOwned.length === 0 && conv.ownedGroupId != null) {
    updates.ownedGroupId = null;
    groupOwnership.delete(conv.ownedGroupId);
  }
  await chatDb.updateConversation(convId, updates);
}

async function clearGroupOwnership(groupId: number) {
  const convId = groupOwnership.get(groupId);
  if (!convId) return;
  groupOwnership.delete(groupId);

  for (const [ltid, cid] of tabOwnership) {
    if (cid !== convId) continue;
    tabOwnership.delete(ltid);
    const ctid = tabRegistry.toChromeTabId(ltid);
    if (ctid != null) {
      applyDesiredPanelState(ctid);
      emitToast(ctid, false);
    }
  }

  const conv = await chatDb.getConversation(convId);
  if (!conv) return;
  await chatDb.updateConversation(convId, {
    ownedGroupId: null,
    ownedLtids: [],
  });
}

/**
 * SW startup reconciliation. For each conversation with an `ownedGroupId`,
 * query Chrome for the tabs in that group and re-mint ltids via the
 * registry. Updates `chatDb.ownedLtids` to reflect the live set, dropping
 * ltids whose ctid is gone and adding ltids minted for newly-discovered
 * tabs. Mirrors the legacy "rebuild from group membership" semantics but
 * keyed on ltid.
 */
async function rebuildIndexesFromStorage() {
  const convs = await chatDb.listConversations();
  tabOwnership.clear();
  groupOwnership.clear();

  for (const conv of convs) {
    if (conv.ownedGroupId == null) continue;
    let groupExists = false;
    let liveCtids: number[] = [];
    try {
      const tabs = await chrome.tabs.query({ groupId: conv.ownedGroupId });
      liveCtids = tabs.map((t) => t.id!).filter((id) => id != null);
      groupExists = liveCtids.length > 0;
    } catch {
      groupExists = false;
    }

    if (!groupExists) {
      await chatDb.updateConversation(conv.id, {
        ownedGroupId: null,
        ownedLtids: [],
      });
      continue;
    }

    groupOwnership.set(conv.ownedGroupId, conv.id);
    const liveLtids: LogicalTabId[] = [];
    for (const ctid of liveCtids) {
      const ltid = tabRegistry.registerExisting(ctid);
      liveLtids.push(ltid);
      tabOwnership.set(ltid, conv.id);
      setPanelEnabledForTab(ctid, true);
    }
    // Persist if the live set differs from what's stored.
    const stored = [...conv.ownedLtids].sort().join(",");
    const live = [...liveLtids].sort().join(",");
    if (stored !== live) {
      await chatDb.updateConversation(conv.id, { ownedLtids: liveLtids });
    }
  }
}

function installListeners() {
  chrome.tabs.onActivated.addListener(async (info) => {
    applyDesiredPanelState(info.tabId);

    const convId = getConversationForTab(info.tabId);
    if (convId) {
      if (sidePanelOpenByWindow.get(info.windowId)) {
        emitFocus(info.windowId, convId);
        emitToast(info.tabId, false);
      } else {
        emitToast(info.tabId, true);
      }
    } else {
      emitToast(info.tabId, false);
    }
  });

  // Side-panel-only ctid bookkeeping: drop the user-opened-panel record
  // when a tab closes. The ownership/handle drops happen via the
  // registry's deduped `onRemove` subscription below.
  chrome.tabs.onRemoved.addListener((tabId) => {
    userOpenedSidePanelTabs.delete(tabId);
  });

  // Registry-driven ownership cleanup. Subscribing to the registry's
  // `onRemove` (NOT `chrome.tabs.onRemoved`) means we get the deduped
  // stream — the trailing `onRemoved` Chrome fires for the old ctid after
  // an `onReplaced` is suppressed, so a prerender activation no longer
  // looks like a tab close to ownership bookkeeping.
  tabRegistry.onRemove(({ ltid }) => {
    if (!tabOwnership.has(ltid)) return;
    void clearTabOwnershipForLtid(ltid);
  });

  // On replace, the ltid is unchanged but the underlying ctid changed:
  // re-register the side panel against the NEW ctid so the user can still
  // open the panel from the (now-replaced) tab. Without this, prerender
  // activation silently disables the side panel on agent-owned tabs.
  tabRegistry.onReplace(({ ltid, newCtid }) => {
    if (!tabOwnership.has(ltid)) return;
    void setPanelEnabledForTab(newCtid, true);
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const ltid = tabRegistry.toLogicalTabId(tabId);
    if (changeInfo.pinned === true && ltid && tabOwnership.has(ltid)) {
      await clearTabOwnershipForLtid(ltid);
      return;
    }
    if (changeInfo.groupId !== undefined && ltid && tabOwnership.has(ltid)) {
      const newGroupId = changeInfo.groupId;
      if (newGroupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await clearTabOwnershipForLtid(ltid);
      } else {
        const ownerForNewGroup = groupOwnership.get(newGroupId);
        const currentOwner = tabOwnership.get(ltid);
        if (ownerForNewGroup !== currentOwner) {
          await clearTabOwnershipForLtid(ltid);
        }
      }
    }
    void tab;
  });

  if (chrome.tabGroups?.onRemoved) {
    chrome.tabGroups.onRemoved.addListener((group) => {
      if (groupOwnership.has(group.id)) {
        clearGroupOwnership(group.id);
      }
    });
  }
}

export function initTabScoping() {
  installListeners();
  void rebuildIndexesFromStorage();
}

/**
 * Auto-delete the agent-owned tabs of conversations whose task is complete
 * and that have gone idle. Replaces the previous "ungroup idle groups"
 * behavior entirely (ungrouping is removed). Closing is reversible: an
 * AGENT_TABS_CLOSED message carrying the undo payload is broadcast so the
 * side panel can show an Undo toast.
 *
 * Eligibility (all required):
 *  - the auto-close setting is ON (`enabled`)
 *  - a positive, finite `timeoutMinutes`
 *  - the conversation has `lastCompletionApproved === true`
 *  - `taskCompletedAt` is set and `now - taskCompletedAt > timeoutMinutes * 60_000`
 *
 * Returns the number of conversations whose tabs were closed.
 */
export async function cleanupCompletedAgentTabs(opts: {
  enabled: boolean;
  timeoutMinutes: number;
}): Promise<number> {
  if (!opts.enabled) return 0;
  if (!Number.isFinite(opts.timeoutMinutes) || opts.timeoutMinutes <= 0) return 0;

  const convs = await chatDb.listConversations();
  const now = Date.now();
  const thresholdMs = opts.timeoutMinutes * 60_000;

  let cleaned = 0;
  for (const conv of convs) {
    if (conv.ownedGroupId == null) continue;
    if (!conv.lastCompletionApproved) continue;
    if (conv.taskCompletedAt == null) continue;
    if (now - conv.taskCompletedAt <= thresholdMs) continue;
    if (conv.ownedLtids.length === 0) continue;

    try {
      const undo = await closeOwnedTabs(conv.id, conv.ownedLtids);
      cleaned++;
      try {
        await chrome.runtime.sendMessage({
          type: "AGENT_TABS_CLOSED",
          conversationId: conv.id,
          undo,
        });
      } catch {
        // No listener (panel closed); the close already happened.
      }
    } catch {
      // Best-effort; a failed conversation shouldn't block the sweep.
    }
  }
  return cleaned;
}

/**
 * Undo payload for a close operation. Shaped to match the `OVERLAY_UNDO`
 * `action: "reopen"` consumer in background/index.ts (it iterates `tabs`
 * and recreates each via chrome.tabs.create).
 */
export interface CloseTabsUndo {
  action: "reopen";
  /**
   * Stable unique id for this close, used to make the `OVERLAY_UNDO`
   * `reopen` handler idempotent (the client may send the same undo twice —
   * e.g. a click racing a ⌘Z). See `reopenTabsOnce`.
   */
  id: string;
  tabs: { url: string; windowId: number; pinned: boolean }[];
}

/**
 * Close a set of agent-owned tabs for a conversation. Captures an undo
 * payload BEFORE removal, removes the tabs (tolerating already-closed
 * ones), then clears ownership: removes the closed ltids from
 * `ownedLtids`, and if no owned ltids remain, nulls `ownedGroupId`.
 * In-memory ownership maps are also cleared (the registry's `onRemove`
 * subscription does this too, but we do it eagerly so callers see
 * consistent state immediately).
 *
 * `ltids` is the conversation's `ownedLtids` array — each entry is
 * resolved to a live ctid via the registry just before `chrome.tabs
 * .remove`. Unresolvable ltids (the underlying tab is already gone) are
 * silently skipped.
 *
 * Defensive ownership filter: each input ltid is validated against the
 * conversation's persisted `ownedLtids` BEFORE any tab is removed. ltids
 * that don't belong to this conversation are silently skipped — protects
 * against a future caller passing the wrong ltid set, and also means a
 * concurrent SW restart that wiped the conversation row degrades to a
 * no-op rather than blindly removing tabs we no longer track.
 */
export async function closeOwnedTabs(
  conversationId: string,
  ltids: LogicalTabId[],
): Promise<CloseTabsUndo> {
  const undo: CloseTabsUndo = {
    action: "reopen",
    id: crypto.randomUUID(),
    tabs: [],
  };

  // Validate ownership up front. If the conversation row is missing the
  // function degrades to a no-op (returns the empty undo) — `ownedLtids`
  // is the source of truth for what we're allowed to close.
  const conv = await chatDb.getConversation(conversationId);
  const ownedSet = new Set(conv?.ownedLtids ?? []);

  for (const ltid of ltids) {
    if (!ownedSet.has(ltid)) continue; // not ours; skip silently
    const ctid = tabRegistry.toChromeTabId(ltid);
    if (ctid != null) {
      try {
        const tab = await chrome.tabs.get(ctid);
        if (tab.url) {
          undo.tabs.push({
            url: tab.url,
            windowId: tab.windowId,
            pinned: !!tab.pinned,
          });
        }
        await chrome.tabs.remove(ctid);
      } catch {
        // Tab already gone; skip from undo and continue.
      }
    }
    tabOwnership.delete(ltid);
  }

  if (conv) {
    const closed = new Set(ltids.filter((l) => ownedSet.has(l)));
    const remaining = conv.ownedLtids.filter((l) => !closed.has(l));
    const updates: { ownedLtids: LogicalTabId[]; ownedGroupId?: number | null } = {
      ownedLtids: remaining,
    };
    if (remaining.length === 0) {
      updates.ownedGroupId = null;
      if (conv.ownedGroupId != null) groupOwnership.delete(conv.ownedGroupId);
    }
    await chatDb.updateConversation(conversationId, updates);
  }

  return undo;
}
