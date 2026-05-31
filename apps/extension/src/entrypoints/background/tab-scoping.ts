import { chatDb } from "@/lib/chat-db";

const tabOwnership = new Map<number, string>();
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
  const tabIds: number[] = [];
  for (const [tabId, cid] of tabOwnership) {
    if (cid === conversationId) tabIds.push(tabId);
  }
  if (tabIds.length === 0) return;
  const dismissed = await getDismissedTabs();
  let changed = false;
  for (const tabId of tabIds) {
    if (dismissed.delete(tabId)) changed = true;
  }
  if (changed) await setDismissedTabs(dismissed);
  for (const tabId of tabIds) {
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.active && !isSidePanelOpenForWindow(tab.windowId!)) {
          emitToast(tabId, true);
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

export function getConversationForTab(tabId: number): string | null {
  return tabOwnership.get(tabId) ?? null;
}

export function getConversationForGroup(groupId: number): string | null {
  return groupOwnership.get(groupId) ?? null;
}

export function isTabOwned(tabId: number): boolean {
  return tabOwnership.has(tabId);
}

export async function registerOwnership(
  conversationId: string,
  groupId: number,
  tabIds: number[],
): Promise<void> {
  groupOwnership.set(groupId, conversationId);
  for (const tabId of tabIds) {
    tabOwnership.set(tabId, conversationId);
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
      if (tab?.id != null && tabOwnership.has(tab.id)) emitToast(tab.id, true);
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
  const owned = tabOwnership.has(tabId);
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

  // For brand-new groups, set an immediate placeholder title so the group is
  // never nameless while the async LLM-based labeler runs. The labeler will
  // overwrite this with a better 2-4 word label when it succeeds; on failure
  // the placeholder remains. The "OB | " prefix tags the group as an
  // OpenBrowse-owned agent group.
  //
  // Subagent runs (rows with `parentConversationId`) get a richer label
  // that surfaces both the parent's title and the subagent slug, so the
  // user can tell which child run a tab group belongs to at a glance.
  if (existingGroupId == null) {
    let placeholder: string;
    if (conv.parentConversationId) {
      const parent = await chatDb.getConversation(conv.parentConversationId);
      const parentBase = (parent?.title ?? "").trim().slice(0, 16) || "Chat";
      const slug = (conv.subagentSlug ?? "").trim().slice(0, 16);
      // Only append the slug suffix when it's a real, non-empty value.
      // Defensive against rows where `subagentSlug` is set but blank
      // (would otherwise produce a trailing " · ").
      placeholder = slug
        ? `OB | ${parentBase} · ${slug}`
        : `OB | ${parentBase}`;
    } else {
      const base = (conv.title ?? "").trim().slice(0, 20) || "Chat";
      placeholder = `OB | ${base}`;
    }
    chrome.tabGroups
      .update(groupId, { title: placeholder, color: "grey" })
      .catch(() => {
        // Group may have been dissolved mid-flight; ignore.
      });
  }

  groupOwnership.set(groupId, conversationId);
  const newOwned = new Set(conv.ownedTabIds);
  for (const id of ids) {
    tabOwnership.set(id, conversationId);
    newOwned.add(id);
    setPanelEnabledForTab(id, true);
    clearToastDismissalForTab(id);
  }

  await chatDb.updateConversation(conversationId, {
    ownedGroupId: groupId,
    ownedTabIds: Array.from(newOwned),
  });

  return { groupId, boundTabIds: ids };
}

async function clearTabOwnership(tabId: number) {
  const convId = tabOwnership.get(tabId);
  if (!convId) return;
  tabOwnership.delete(tabId);
  applyDesiredPanelState(tabId);
  emitToast(tabId, false);

  const conv = await chatDb.getConversation(convId);
  if (!conv) return;
  const nextOwned = conv.ownedTabIds.filter((t) => t !== tabId);
  await chatDb.updateConversation(convId, { ownedTabIds: nextOwned });
}

async function clearGroupOwnership(groupId: number) {
  const convId = groupOwnership.get(groupId);
  if (!convId) return;
  groupOwnership.delete(groupId);

  for (const [tabId, cid] of tabOwnership) {
    if (cid === convId) {
      tabOwnership.delete(tabId);
      applyDesiredPanelState(tabId);
      emitToast(tabId, false);
    }
  }

  const conv = await chatDb.getConversation(convId);
  if (!conv) return;
  await chatDb.updateConversation(convId, {
    ownedGroupId: null,
    ownedTabIds: [],
  });
}

async function rebuildIndexesFromStorage() {
  const convs = await chatDb.listConversations();
  tabOwnership.clear();
  groupOwnership.clear();

  for (const conv of convs) {
    if (conv.ownedGroupId == null) continue;
    let groupExists = false;
    let liveTabIds: number[] = [];
    try {
      const tabs = await chrome.tabs.query({ groupId: conv.ownedGroupId });
      liveTabIds = tabs.map((t) => t.id!).filter((id) => id != null);
      groupExists = liveTabIds.length > 0;
    } catch {
      groupExists = false;
    }

    if (!groupExists) {
      await chatDb.updateConversation(conv.id, {
        ownedGroupId: null,
        ownedTabIds: [],
      });
      continue;
    }

    groupOwnership.set(conv.ownedGroupId, conv.id);
    for (const tabId of liveTabIds) {
      tabOwnership.set(tabId, conv.id);
      setPanelEnabledForTab(tabId, true);
    }
    if (liveTabIds.sort().join(",") !== [...conv.ownedTabIds].sort().join(",")) {
      await chatDb.updateConversation(conv.id, { ownedTabIds: liveTabIds });
    }
  }
}

function installListeners() {
  chrome.tabs.onActivated.addListener(async (info) => {
    applyDesiredPanelState(info.tabId);
    
    const convId = tabOwnership.get(info.tabId);
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

  chrome.tabs.onRemoved.addListener((tabId) => {
    userOpenedSidePanelTabs.delete(tabId);
    if (!tabOwnership.has(tabId)) return;
    clearTabOwnership(tabId);
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.pinned === true && tabOwnership.has(tabId)) {
      await clearTabOwnership(tabId);
      return;
    }
    if (changeInfo.groupId !== undefined && tabOwnership.has(tabId)) {
      const newGroupId = changeInfo.groupId;
      if (newGroupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await clearTabOwnership(tabId);
      } else {
        const ownerForNewGroup = groupOwnership.get(newGroupId);
        const currentOwner = tabOwnership.get(tabId);
        if (ownerForNewGroup !== currentOwner) {
          await clearTabOwnership(tabId);
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

export async function cleanupIdleOwnedGroups(
  idleHours: number,
): Promise<number> {
  const convs = await chatDb.listConversations();
  const now = Date.now();
  const thresholdMs = idleHours * 60 * 60 * 1000;

  let cleaned = 0;
  for (const conv of convs) {
    if (conv.ownedGroupId == null) continue;
    if (now - conv.updatedAt <= thresholdMs) continue;

    try {
      const tabs = await chrome.tabs.query({ groupId: conv.ownedGroupId });
      const tabIds = tabs.map((t) => t.id!).filter((id) => id != null);
      if (tabIds.length > 0) {
        await chrome.tabs.ungroup(tabIds as [number, ...number[]]);
      }
    } catch {
      // Group already dissolved; onRemoved handlers will have cleared ownership.
    }

    // Clear ownership explicitly — ungroup fires onUpdated per tab which
    // clears tabOwnership, but we also need to null out the DB fields.
    await chatDb.updateConversation(conv.id, {
      ownedGroupId: null,
      ownedTabIds: [],
    });
    groupOwnership.delete(conv.ownedGroupId);
    cleaned++;
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
  tabs: { url: string; windowId: number; pinned: boolean }[];
}

/**
 * Close a set of agent-owned tabs for a conversation. Captures an undo
 * payload BEFORE removal, removes the tabs (tolerating already-closed
 * ones), then clears ownership: removes the closed ids from
 * `ownedTabIds`, and if no owned tabs remain, nulls `ownedGroupId`.
 * In-memory ownership maps are also cleared (onRemoved listeners do this
 * too, but we do it eagerly so callers see consistent state immediately).
 */
export async function closeOwnedTabs(
  conversationId: string,
  tabIds: number[],
): Promise<CloseTabsUndo> {
  const undo: CloseTabsUndo = { action: "reopen", tabs: [] };

  for (const tabId of tabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url) {
        undo.tabs.push({
          url: tab.url,
          windowId: tab.windowId,
          pinned: !!tab.pinned,
        });
      }
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab already gone; skip from undo and continue.
    }
    tabOwnership.delete(tabId);
  }

  const conv = await chatDb.getConversation(conversationId);
  if (conv) {
    const closed = new Set(tabIds);
    const remaining = conv.ownedTabIds.filter((id) => !closed.has(id));
    const updates: { ownedTabIds: number[]; ownedGroupId?: number | null } = {
      ownedTabIds: remaining,
    };
    if (remaining.length === 0) {
      updates.ownedGroupId = null;
      if (conv.ownedGroupId != null) groupOwnership.delete(conv.ownedGroupId);
    }
    await chatDb.updateConversation(conversationId, updates);
  }

  return undo;
}
