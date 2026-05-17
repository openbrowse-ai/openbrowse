import type { TidyState, SortResult, ModelStatus } from "@/lib/types";
import { markUserOpenedSidePanel, markUserClosedSidePanel, isUserOpenedSidePanel } from "./tab-scoping";
import { openHomePage } from "./messages";

function getTidyState(data: Record<string, unknown>, key: string): TidyState {
  return (data[key] as TidyState) ?? {
    sections: [],
    tabAssignments: {},
    tidiedTitles: {},
    manualTitles: {},
  };
}

export default defineBackground({
  main() {
    chrome.action.onClicked.addListener(async (tab) => {
      if (!tab.id || !tab.windowId) return;
      const ownExtUrl = chrome.runtime.getURL("");
      if (tab.url?.startsWith(ownExtUrl)) {
        chrome.runtime.sendMessage({ type: "TOGGLE_HOME_OVERLAY", windowId: tab.windowId });
        return;
      }
      if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
        return;
      }
      const { sendToContentScript } = await import("@/lib/agent/active-tab");
      try {
        await sendToContentScript(tab.id, { type: "TOGGLE_OVERLAY" });
      } catch {
        // Cannot inject into this page
      }
    });

    let lastFocusedWindowId: number | undefined;
    let agentWorkingTabId: number | null | undefined = null;
    let agentWorkingColor: string | null = null;
    const pendingNotifications = new Map<string, { conversationId: string; origin: "sidepanel" | "home" }>();

    // windowId → active tabId. Maintained synchronously off chrome.tabs events
    // so chrome.sidePanel.open({tabId}) can be called inline from a user
    // gesture without breaking the activation chain by awaiting a tabs.query.
    const activeTabByWindow = new Map<number, number>();

    // Helper to dry up the gesture-sensitive side panel open paths.
    // Because the manifest does not declare a `side_panel.default_path`,
    // Chrome treats this extension as having NO global side panel by
    // default. We register the panel per-tab here, giving us native
    // per-tab scoping with no need to pre-disable other tabs.
    function openSidePanelOnTab(tabId: number) {
      // Eagerly mark as user-opened. This acts as a fallback for Chrome <141
      // which doesn't support chrome.sidePanel.onOpened.
      markUserOpenedSidePanel(tabId);
      // Register the panel for this tab. Without this call, Chrome has no
      // record of a panel for this tab and open() will reject.
      chrome.sidePanel
        .setOptions({ tabId, path: "sidepanel.html", enabled: true })
        .catch(() => {});
      chrome.sidePanel.open({ tabId }).catch(() => {});
    }

    // Chrome lifecycle events keep `userOpenedSidePanelTabs` in sync
    // automatically when present. `onOpened` is Chrome 141+; `onClosed`
    // is Chrome 142+. Both are feature-detected; callers also eagerly
    // mark/unmark on user gestures as a fallback for older Chrome.
    if (chrome.sidePanel.onOpened) {
      chrome.sidePanel.onOpened.addListener((info) => {
        if (info.tabId != null) markUserOpenedSidePanel(info.tabId);
      });
    }
    if (chrome.sidePanel.onClosed) {
      chrome.sidePanel.onClosed.addListener((info) => {
        if (info.tabId != null) {
          markUserClosedSidePanel(info.tabId);
          chrome.sidePanel
            .setOptions({ tabId: info.tabId, path: "sidepanel.html", enabled: false })
            .catch(() => {});
        }
      });
    }

    // Track the most recently focused *normal* browser window. We
    // deliberately exclude `popup`/`devtools` windows so that focusing
    // the detached popover doesn't redirect gesture-bridged actions
    // (Alt+I, search, notifications) to the popup's window — those
    // need to target the user's real browsing window.
    chrome.windows.getLastFocused({ windowTypes: ["normal"] }).then((w) => {
      if (w.id != null) lastFocusedWindowId = w.id;
    });

    // Seed activeTabByWindow on startup. We no longer need to pre-disable
    // every existing tab — without a default global panel, Chrome naturally
    // shows nothing on tabs that haven't called setOptions.
    chrome.windows.getAll({ populate: true }).then((wins) => {
      for (const w of wins) {
        if (w.id == null) continue;
        const active = w.tabs?.find((t) => t.active);
        if (active?.id != null) activeTabByWindow.set(w.id, active.id);
      }
    });

    chrome.tabs.onActivated.addListener((info) => {
      activeTabByWindow.set(info.windowId, info.tabId);
    });

    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id != null && tab.windowId != null && tab.active) {
        activeTabByWindow.set(tab.windowId, tab.id);
      }
    });

    chrome.windows.onRemoved.addListener((windowId) => {
      activeTabByWindow.delete(windowId);
    });

    // Connect MCP servers on startup
    import("@/lib/storage").then(async ({ storage }) => {
      const settings = await storage.getSettings();
      if (settings.mcpServers.length > 0) {
        const { backgroundMcpRegistry } = await import("./mcp-registry");
        await backgroundMcpRegistry.connectAll(settings.mcpServers);
      }
    });

    import("./tab-scoping").then(({ initTabScoping, onFocusConversation }) => {
      initTabScoping();
      onFocusConversation((windowId, conversationId) => {
        chrome.runtime
          .sendMessage({ type: "FOCUS_CONVERSATION", windowId, conversationId })
          .catch(() => {});
      });
    });
    chrome.windows.onFocusChanged.addListener(async (windowId) => {
      if (windowId === chrome.windows.WINDOW_ID_NONE) return;
      // Only track focus on normal browser windows. Popup-type windows
      // (such as our detached popover) and devtools windows must not
      // override lastFocusedWindowId, otherwise gesture-bridged actions
      // would target the popup instead of the user's real window.
      try {
        const w = await chrome.windows.get(windowId);
        if (w.type === "normal") lastFocusedWindowId = windowId;
      } catch {
        // Window vanished between focus event and lookup — ignore.
      }
    });

    chrome.commands.onCommand.addListener((command) => {
      if (command === "open-chat") {
        const windowId = lastFocusedWindowId;

        const toggleOnTab = (tabId: number) => {
          const opened = isUserOpenedSidePanel(tabId);
          if (opened && chrome.sidePanel.close) {
            markUserClosedSidePanel(tabId);
            chrome.sidePanel.close({ tabId }).catch(() => {});
            chrome.sidePanel
              .setOptions({ tabId, path: "sidepanel.html", enabled: false })
              .catch(() => {});
          } else {
            openSidePanelOnTab(tabId);
          }
        };

        if (windowId == null) {
          chrome.windows.getLastFocused({ windowTypes: ["normal"] }).then((w) => {
            if (w.id == null) return;
            const tabId = activeTabByWindow.get(w.id);
            if (tabId != null) toggleOnTab(tabId);
          });
          return;
        }

        const tabId = activeTabByWindow.get(windowId);
        if (tabId != null) toggleOnTab(tabId);
        return;
      }

      if (command === "open-home") {
        // openHomePage uses chrome.tabs APIs, which don't require a user
        // gesture, so we can safely await.
        (async () => {
          const windowId = lastFocusedWindowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
          if (windowId == null) return;
          await openHomePage(windowId);
        })();
        return;
      }

      if (command === "open-search") {
        (async () => {
          const windowId = lastFocusedWindowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
          if (!windowId) return;

          const [tab] = await chrome.tabs.query({ active: true, windowId });
          if (!tab?.id || tab.url?.startsWith("chrome://")) {
            return;
          }
          const homeUrl = chrome.runtime.getURL("/home.html");
          if (tab.url?.startsWith(homeUrl)) {
            chrome.runtime.sendMessage({ type: "TOGGLE_HOME_OVERLAY", windowId });
            return;
          }
          const ownExtUrl = chrome.runtime.getURL("");
          if (tab.url?.startsWith("chrome-extension://") && !tab.url.startsWith(ownExtUrl)) {
            return;
          }
          if (tab.url?.startsWith(ownExtUrl)) {
            chrome.runtime.sendMessage({ type: "TOGGLE_HOME_OVERLAY", windowId });
            return;
          }
          const { sendToContentScript } = await import("@/lib/agent/active-tab");
          try {
            await sendToContentScript(tab.id, { type: "TOGGLE_OVERLAY" });
          } catch {
            // Cannot inject into this page
          }
        })();
      }
    });

    async function runOverlayTidy(windowId: number) {
      const { storage } = await import("@/lib/storage");
      const space = await storage.getSpaceByWindowId(windowId);
      if (!space) return;
      const { getAssociatedTabIds: getFavTabIds } = await import("./favorite-tabs");
      const favTabIds = getFavTabIds(space.id);
      const favoriteUrls = new Set(space.favorites.map((f) => f.url));
      const homeUrl = chrome.runtime.getURL("/home.html");
      const sidepanelUrl = chrome.runtime.getURL("/sidepanel.html");
      const overlayUrl = chrome.runtime.getURL("/overlay.html");
      const allTabs = await chrome.tabs.query({ windowId });
      const eligible = allTabs.filter(
        (t) =>
          t.id &&
          t.url &&
          !t.pinned &&
          !t.url.startsWith(homeUrl) &&
          !t.url.startsWith(sidepanelUrl) &&
          !t.url.startsWith(overlayUrl) &&
          !favTabIds.has(t.id!) &&
          !favoriteUrls.has(t.url),
      );
      if (eligible.length === 0) return;
      const tabData = eligible.map((t) => ({
        id: String(t.id!),
        url: t.url!,
        title: t.title ?? "Untitled",
      }));
      try {
        const { enrichWithSettings } = await import("./auto-tidy");
        const { ensureOffscreenDocument } = await import("./messages");
        await ensureOffscreenDocument();
        const { sendToOffscreen } = await import("@/lib/messages");
        const enriched = await enrichWithSettings({ type: "SORT_TABS", tabs: tabData });
        const result = (await sendToOffscreen(enriched)) as SortResult & { error?: string };
        if (result?.archivedTabIds?.length) {
          const tabIdsToClose = result.archivedTabIds
            .map((id: string) => Number(id))
            .filter((id: number) => !Number.isNaN(id));
          if (tabIdsToClose.length > 0) {
            await chrome.tabs.remove(tabIdsToClose);
          }
        }
        if (result && !result.error) {
          // Store stats for the overlay banner
          await chrome.storage.local.set({
            _lastTidyStats: {
              archivedCount: result.archivedTabIds?.length ?? 0,
              sectionCount: result.sections?.length ?? 0,
              tabCount: tabData.length,
            },
          });

          // Persist tidy state so home page picks it up
          const sections = (result.sections || []).map((s: { name: string; tabs: { id: string; tidiedTitle: string }[] }, i: number) => ({
            id: crypto.randomUUID(),
            name: s.name,
            position: i,
            collapsed: false,
          }));
          const tabAssignments: Record<number, string> = {};
          const tidiedTitles: Record<number, string> = {};
          for (let i = 0; i < sections.length; i++) {
            for (const tab of result.sections[i].tabs) {
              const chromeId = Number(tab.id);
              if (!Number.isNaN(chromeId)) {
                tabAssignments[chromeId] = sections[i].id;
                tidiedTitles[chromeId] = tab.tidiedTitle;
              }
            }
          }
          if (result.tabs) {
            for (const tab of result.tabs) {
              const chromeId = Number(tab.id);
              if (!Number.isNaN(chromeId)) {
                tidiedTitles[chromeId] = tab.tidiedTitle;
              }
            }
          }
          const existing = await chrome.storage.local.get(`_tidyState:${space.id}`);
          const prev = getTidyState(existing, `_tidyState:${space.id}`);
          await chrome.storage.local.set({
            [`_tidyState:${space.id}`]: {
              sections,
              tabAssignments,
              tidiedTitles,
              manualTitles: prev.manualTitles ?? {},
            },
          });
        }
      } finally {
        await chrome.storage.local.set({
          _tidyProgress: { phase: -1, current: 0, total: 0 },
        });
      }
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log("[BG] onMessage:", message.type);
      if (message.type?.startsWith("MCP_")) {
        (async () => {
          try {
            const { handleMcpMessage } = await import("./mcp-messages");
            handleMcpMessage(message, sendResponse);
          } catch (err) {
            console.error("[MCP bg] Error:", err);
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      // Handle new registry-based TEST_CONNECTION from ProviderConfigDialog
      if (message.type === "TEST_CONNECTION" && message.config) {
        (async () => {
          try {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = await sendToOffscreen({
              type: "TEST_CONNECTION_REGISTRY",
              providerId: message.provider,
              config: message.config,
              modelId: message.modelId,
            });
            sendResponse(result);
          } catch (err) {
            sendResponse({ error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "GET_CURRENT_TAB") {
        (async () => {
          try {
            const [tab] = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });
            if (tab) {
              sendResponse({
                ok: true,
                tab: {
                  url: tab.url ?? "",
                  title: tab.title ?? "",
                  favIconUrl: tab.favIconUrl ?? "",
                },
              });
            } else {
              sendResponse({ ok: false, error: "No active tab" });
            }
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "GET_OR_CREATE_SPACE") {
        import("./spaces")
          .then(async ({ getOrCreateSpaceForWindow }) => {
            const space = await getOrCreateSpaceForWindow(message.windowId);
            sendResponse({ ok: true, spaceId: space.id });
          })
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }

      if (message.type === "BIND_TABS_TO_CONVERSATION") {
        (async () => {
          try {
            const { bindTabsToConversation } = await import("./tab-scoping");
            const result = await bindTabsToConversation(
              message.conversationId,
              message.tabIds ?? [],
            );
            import("./group-label").then(({ maybeGenerateGroupLabel }) => {
              if (result.groupId != null) {
                maybeGenerateGroupLabel(message.conversationId, result.groupId);
              }
            });
            sendResponse({ ok: true, ...result });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "REGISTER_CONVERSATION_OWNERSHIP") {
        (async () => {
          try {
            const { registerOwnership } = await import("./tab-scoping");
            await registerOwnership(
              message.conversationId,
              message.groupId,
              message.tabIds ?? [],
            );
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "BIND_ACTIVE_TAB_TO_CONVERSATION") {
        (async () => {
          try {
            const { bindTabsToConversation } = await import("./tab-scoping");
            const result = await bindTabsToConversation(
              message.conversationId,
              [message.tabId],
            );
            import("./group-label").then(({ maybeGenerateGroupLabel }) => {
              if (result.groupId != null) {
                maybeGenerateGroupLabel(message.conversationId, result.groupId);
              }
            });
            sendResponse({ ok: true, ...result });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OPEN_SIDEPANEL_FROM_OVERLAY") {
        (async () => {
          try {
            const tabId = sender.tab?.id;
            if (tabId != null) {
              openSidePanelOnTab(tabId);
            }
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "DISMISS_TOAST") {
        (async () => {
          try {
            const tabId = sender.tab?.id;
            if (tabId != null) {
              const { markToastDismissed } = await import("./tab-scoping");
              await markToastDismissed(tabId);
            }
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "GET_CONVERSATION_FOR_ACTIVE_TAB") {
        (async () => {
          try {
            const windowId = message.windowId as number | undefined;
            const [tab] = windowId
              ? await chrome.tabs.query({ windowId, active: true })
              : await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id == null) {
              sendResponse({ ok: true, conversationId: null });
              return;
            }
            const { getConversationForTab } = await import("./tab-scoping");
            sendResponse({
              ok: true,
              conversationId: getConversationForTab(tab.id),
              tabId: tab.id,
              pinned: tab.pinned === true,
            });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "GET_FAVORITE_ASSOCIATIONS") {
        import("./favorite-tabs").then(({ getAssociations }) => {
          sendResponse({ ok: true, associations: getAssociations(message.spaceId) });
        });
        return true;
      }

      if (message.type === "CLEAR_FAVORITE_ASSOCIATION") {
        import("./favorite-tabs").then(({ disassociateByFavorite }) => {
          disassociateByFavorite(message.spaceId, message.favoriteUrl);
          sendResponse({ ok: true });
        });
        return true;
      }

      if (message.type === "OVERLAY_READY") {
        (async () => {
          try {
            const { storage } = await import("@/lib/storage");
            const { getOrCreateSpaceForWindow } = await import("./spaces");
            const windowId = sender.tab?.windowId;
            let activeSpaceId: string | null = null;
            if (windowId) {
              const space = await getOrCreateSpaceForWindow(windowId);
              activeSpaceId = space.id;
            }
            const spaces = await storage.getSpaces();
            const autoTidyNotification = await storage.getAutoTidyNotification();
            sendResponse({ ok: true, spaces, activeSpaceId, windowId: windowId ?? null, autoTidyNotification });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }



      if (message.type === "DISMISS_AUTO_TIDY_NOTIFICATION") {
        (async () => {
          const { storage } = await import("@/lib/storage");
          await storage.clearAutoTidyNotification();
          sendResponse({ ok: true });
        })();
        return true;
      }

      if (message.type === "AGENT_NOTIFY") {
        (async () => {
          try {
          const { storage } = await import("@/lib/storage");
          const settings = await storage.getSettings();
          console.log("[BG] AGENT_NOTIFY received, notificationsEnabled:", settings.notificationsEnabled);
          if (!settings.notificationsEnabled) {
            sendResponse({ ok: true });
            return;
          }
          const { kind, snippet, conversationId, origin } = message.payload as {
            kind: "complete" | "approval-needed";
            conversationId: string;
            snippet: string;
            origin: "sidepanel" | "home";
          };
          const title = kind === "complete" ? "OpenBrowse: Agent finished" : "OpenBrowse: Approval needed";
          const notifMessage = kind === "complete"
            ? snippet
            : `${snippet} wants to run`;
          const notificationId = `openbrowse-${conversationId}-${Date.now()}`;
          chrome.notifications.create(notificationId, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icon/128.png"),
            title,
            message: notifMessage,
          }, (id) => {
            if (chrome.runtime.lastError) {
              console.error("[BG] notifications.create error:", chrome.runtime.lastError.message);
            } else {
              console.log("[BG] notification created:", id);
            }
          });
          pendingNotifications.set(notificationId, { conversationId, origin });
          import("./tab-scoping").then(({ clearToastDismissalForConversation }) => {
            clearToastDismissalForConversation(conversationId).catch(() => {});
          });
          sendResponse({ ok: true });
          } catch (err) {
            console.error("[BG] AGENT_NOTIFY error:", err);
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "GET_TIDY_STATS") {
        (async () => {
          const data = await chrome.storage.local.get("_lastTidyStats");
          const stats = data._lastTidyStats;
          if (stats) {
            await chrome.storage.local.remove("_lastTidyStats");
            sendResponse({ ok: true, ...stats });
          } else {
            sendResponse({ ok: false });
          }
        })();
        return true;
      }

      if (message.type === "GET_OVERLAY_TABS") {
        (async () => {
          try {
            const { storage } = await import("@/lib/storage");
            const homeUrl = chrome.runtime.getURL("/home.html");
            const sidepanelUrl = chrome.runtime.getURL("/sidepanel.html");
            const overlayUrl = chrome.runtime.getURL("/overlay.html");
            const isExtPage = (url?: string) =>
              !url || url.startsWith(homeUrl) || url.startsWith(sidepanelUrl) || url.startsWith(overlayUrl);

            const mapTab = (t: chrome.tabs.Tab, spaceName?: string, spaceIcon?: string | null) => ({
              id: t.id!,
              url: t.url ?? "",
              title: t.title ?? "Untitled",
              favicon: t.favIconUrl ?? "",
              pinned: t.pinned ?? false,
              active: t.active ?? false,
              windowId: t.windowId!,
              spaceName,
              spaceIcon: spaceIcon ?? undefined,
            });

            const windowId = message.windowId as number;
            const windowTabs = (await chrome.tabs.query({ windowId }))
              .map((t) => mapTab(t));

            const spaces = await storage.getSpaces();
            const allTabs: typeof windowTabs = [];
            for (const space of spaces) {
              if (!space.windowId || space.windowId === windowId) continue;
              const tabs = await chrome.tabs.query({ windowId: space.windowId });
              for (const t of tabs) {
                allTabs.push(mapTab(t, space.name, space.icon));
              }
            }

            const activeSpace = spaces.find((s) => s.windowId === windowId);
            let tidyState = null;
            if (activeSpace) {
              const tidyKey = `_tidyState:${activeSpace.id}`;
              const tidyData = await chrome.storage.local.get(tidyKey);
              tidyState = tidyData[tidyKey] ?? null;
            }

            const recentlyClosed: { url: string; title: string; favicon: string; lastVisitTime: number; visitCount: number; sessionId?: string }[] = [];
            try {
              const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
              const seenUrls = new Set<string>();
              const openUrls = new Set(windowTabs.map((t) => t.url));
              for (const s of sessions) {
                if (s.tab && s.tab.url && !openUrls.has(s.tab.url) && !seenUrls.has(s.tab.url)) {
                  seenUrls.add(s.tab.url);
                  recentlyClosed.push({
                    url: s.tab.url,
                    title: s.tab.title ?? "",
                    favicon: s.tab.favIconUrl ?? "",
                    lastVisitTime: s.lastModified ? s.lastModified * 1000 : Date.now(),
                    visitCount: 1,
                    sessionId: s.tab.sessionId,
                  });
                } else if (s.window && s.window.tabs) {
                  for (const t of s.window.tabs) {
                    if (!t.url || openUrls.has(t.url) || seenUrls.has(t.url)) continue;
                    seenUrls.add(t.url);
                    recentlyClosed.push({
                      url: t.url,
                      title: t.title ?? "",
                      favicon: t.favIconUrl ?? "",
                      lastVisitTime: s.lastModified ? s.lastModified * 1000 : Date.now(),
                      visitCount: 1,
                      sessionId: t.sessionId,
                    });
                  }
                }
              }
            } catch {
              // chrome.sessions may be unavailable in some contexts; fall back gracefully.
            }

            const bookmarkTree = await chrome.bookmarks.getTree();
            const bookmarks: { url: string; title: string; favicon: string }[] = [];
            const walkBookmarks = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => {
              for (const node of nodes) {
                if (node.url) {
                  bookmarks.push({ url: node.url, title: node.title ?? "", favicon: "" });
                }
                if (node.children) walkBookmarks(node.children);
              }
            };
            walkBookmarks(bookmarkTree);

            const { getAssociations: getFavAssoc } = await import("./favorite-tabs");
            const favoriteAssociations = activeSpace ? getFavAssoc(activeSpace.id) : [];

            sendResponse({ ok: true, tabs: windowTabs, allTabs, tidyState, recentlyClosed, bookmarks, spaces, activeSpaceId: activeSpace?.id ?? null, favoriteAssociations });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "SEARCH_HISTORY") {
        (async () => {
          try {
            const { query, maxResults = 200 } = message as { type: string; query: string; maxResults?: number };
            // chrome.history.search defaults startTime to 24h ago; pass 0 to search the full history
            // (Chrome internally caps the candidate pool, and maxResults bounds the response).
            const historyItems = await chrome.history.search({ text: query, maxResults, startTime: 0 });
            const results = historyItems
              .filter((h) => h.url)
              .map((h) => ({
                url: h.url!,
                title: h.title ?? "",
                favicon: "",
                lastVisitTime: h.lastVisitTime ?? 0,
                visitCount: h.visitCount ?? 0,
              }));
            sendResponse({ ok: true, results });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_TAB_ACTION") {
        (async () => {
          try {
            const { action, tabId, url } = message as {
              type: string;
              action: string;
              tabId: number;
              url: string;
            };

            if (action === "close") {
              const tab = await chrome.tabs.get(tabId);
              const closedUrl = tab.url ?? url;
              const wasPinned = tab.pinned;
              const closedWindowId = tab.windowId;
              await chrome.tabs.remove(tabId);
              sendResponse({ ok: true, undo: { action: "close", url: closedUrl, pinned: wasPinned, windowId: closedWindowId } });
              return;
            } else if (action === "pin" || action === "unpin") {
              const { storage } = await import("@/lib/storage");
              const { associate: assocUnpin } = await import("./favorite-tabs");
              let prevFavorites: any[] | undefined;
              let spaceId: string | undefined;
              await chrome.tabs.update(tabId, { pinned: action === "pin" });
              if (action === "unpin") {
                const wId = sender.tab?.windowId;
                if (wId) {
                  const space = await storage.getSpaceByWindowId(wId);
                  if (space) {
                    prevFavorites = [...space.favorites];
                    spaceId = space.id;
                    if (!space.favorites.some((f) => f.url === url)) {
                      const tab = await chrome.tabs.get(tabId);
                      const newFav = {
                        url,
                        title: tab.title ?? url,
                        favicon: tab.favIconUrl ?? "",
                        position: space.favorites.length,
                      };
                      await storage.updateSpace(space.id, {
                        favorites: [...space.favorites, newFav],
                      });
                    }
                    assocUnpin(space.id, url, tabId, url, url, "");
                  }
                }
              }
              sendResponse({ ok: true, undo: { action, tabId, prevFavorites, spaceId } });
              return;
            } else if (action === "favorite") {
              const { storage } = await import("@/lib/storage");
              const { associate: assocFav } = await import("./favorite-tabs");
              const windowId = sender.tab?.windowId;
              if (windowId) {
                const space = await storage.getSpaceByWindowId(windowId);
                if (space && !space.favorites.some((f) => f.url === url)) {
                  const prevFavorites = [...space.favorites];
                  const tab = await chrome.tabs.get(tabId);
                  const newFav = {
                    url,
                    title: tab.title ?? url,
                    favicon: tab.favIconUrl ?? "",
                    position: space.favorites.length,
                  };
                  await storage.updateSpace(space.id, {
                    favorites: [...space.favorites, newFav],
                  });
                  assocFav(space.id, url, tabId, tab.url ?? url, tab.title ?? url, tab.favIconUrl ?? "");
                  sendResponse({ ok: true, undo: { action: "favorite", spaceId: space.id, prevFavorites } });
                  return;
                }
              }
            } else if (action === "unfavorite") {
              const { storage } = await import("@/lib/storage");
              const { disassociateByFavorite } = await import("./favorite-tabs");
              const windowId = sender.tab?.windowId;
              if (windowId) {
                const space = await storage.getSpaceByWindowId(windowId);
                if (space) {
                  const prevFavorites = [...space.favorites];
                  await storage.updateSpace(space.id, {
                    favorites: space.favorites.filter((f) => f.url !== url),
                  });
                  disassociateByFavorite(space.id, url);
                  sendResponse({ ok: true, undo: { action: "unfavorite", spaceId: space.id, prevFavorites } });
                  return;
                }
              }
            } else if (action === "rename") {
              const { storage } = await import("@/lib/storage");
              const wId = sender.tab?.windowId;
              if (wId) {
                const space = await storage.getSpaceByWindowId(wId);
                if (space) {
                  const tidyKey = `_tidyState:${space.id}`;
                  const tidyData = await chrome.storage.local.get(tidyKey);
                  const prev = getTidyState(tidyData, tidyKey);
                  const newTitle = (message as { newTitle: string }).newTitle;
                  await chrome.storage.local.set({
                    [tidyKey]: {
                      ...prev,
                      manualTitles: { ...prev.manualTitles, [tabId]: newTitle },
                    },
                  });
                }
              }
            } else if (action === "open") {
              const targetTab = await chrome.tabs.get(tabId);
              await chrome.tabs.update(tabId, { active: true });
              if (targetTab.windowId) {
                await chrome.windows.update(targetTab.windowId, { focused: true });
              }
            }

            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_MOVE_TAB") {
        (async () => {
          try {
            const { tabId, targetSpaceId } = message as {
              type: string;
              tabId: number;
              targetSpaceId: string;
            };
            const { storage } = await import("@/lib/storage");
            const spaces = await storage.getSpaces();
            const targetSpace = spaces.find((s) => s.id === targetSpaceId);
            if (!targetSpace) { sendResponse({ ok: false, error: "Space not found" }); return; }
            const tab = await chrome.tabs.get(tabId);
            const sourceWindowId = tab.windowId;
            const { focusOrCreateWindow } = await import("./spaces");
            await focusOrCreateWindow(targetSpace);
            const updated = await storage.getSpaces();
            const targetWindowId = updated.find((s) => s.id === targetSpaceId)?.windowId;
            if (!targetWindowId) { sendResponse({ ok: false, error: "No window" }); return; }
            await chrome.tabs.move(tabId, { windowId: targetWindowId, index: -1 });
            sendResponse({ ok: true, undo: { tabId, sourceWindowId } });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_MOVE_FAVORITE") {
        (async () => {
          try {
            const { url, targetSpaceId } = message as {
              type: string;
              url: string;
              targetSpaceId: string;
            };
            const { storage } = await import("@/lib/storage");
            const spaces = await storage.getSpaces();
            const currentSpace = spaces.find((s) => s.favorites.some((f) => f.url === url));
            const targetSpace = spaces.find((s) => s.id === targetSpaceId);
            if (!currentSpace || !targetSpace) { sendResponse({ ok: false, error: "Space not found" }); return; }
            const fav = currentSpace.favorites.find((f) => f.url === url);
            if (!fav) { sendResponse({ ok: false, error: "Favorite not found" }); return; }
            const prevSourceFavorites = [...currentSpace.favorites];
            await storage.updateSpace(currentSpace.id, {
              favorites: currentSpace.favorites.filter((f) => f.url !== url),
            });
            const maxPos = targetSpace.favorites.reduce((m, f) => Math.max(m, f.position), -1);
            const prevTargetFavorites = [...targetSpace.favorites];
            await storage.updateSpace(targetSpaceId, {
              favorites: [...targetSpace.favorites, { ...fav, position: maxPos + 1 }],
            });
            sendResponse({ ok: true, undo: { sourceSpaceId: currentSpace.id, prevSourceFavorites, targetSpaceId, prevTargetFavorites } });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_UNDO") {
        (async () => {
          try {
            const { undoData } = message as { type: string; undoData: any };
            if (!undoData) { sendResponse({ ok: false }); return; }

            if (undoData.action === "close") {
              await chrome.tabs.create({ url: undoData.url, pinned: undoData.pinned, windowId: undoData.windowId });
            } else if (undoData.action === "pin") {
              await chrome.tabs.update(undoData.tabId, { pinned: false });
              if (undoData.spaceId && undoData.prevFavorites) {
                const { storage: st } = await import("@/lib/storage");
                await st.updateSpace(undoData.spaceId, { favorites: undoData.prevFavorites });
              }
            } else if (undoData.action === "unpin") {
              const { storage } = await import("@/lib/storage");
              await chrome.tabs.update(undoData.tabId, { pinned: true });
              if (undoData.spaceId && undoData.prevFavorites) {
                await storage.updateSpace(undoData.spaceId, { favorites: undoData.prevFavorites });
              }
            } else if (undoData.action === "favorite" || undoData.action === "unfavorite") {
              const { storage } = await import("@/lib/storage");
              if (undoData.spaceId && undoData.prevFavorites) {
                await storage.updateSpace(undoData.spaceId, { favorites: undoData.prevFavorites });
              }
            } else if (undoData.action === "move-favorite") {
              const { storage } = await import("@/lib/storage");
              await storage.updateSpace(undoData.sourceSpaceId, { favorites: undoData.prevSourceFavorites });
              await storage.updateSpace(undoData.targetSpaceId, { favorites: undoData.prevTargetFavorites });
            } else if (undoData.action === "move") {
              await chrome.tabs.move(undoData.tabId, { windowId: undoData.sourceWindowId, index: -1 });
            } else if (undoData.action === "clean") {
              for (const url of undoData.closedUrls ?? []) {
                await chrome.tabs.create({ url, windowId: undoData.windowId });
              }
            }

            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_RENAME_SECTION") {
        (async () => {
          try {
            const { oldName, newName } = message as {
              type: string;
              oldName: string;
              newName: string;
            };
            const { storage } = await import("@/lib/storage");
            const wId = sender.tab?.windowId;
            if (!wId) { sendResponse({ ok: false }); return; }
            const space = await storage.getSpaceByWindowId(wId);
            if (!space) { sendResponse({ ok: false }); return; }

            const tidyKey = `_tidyState:${space.id}`;
            const tidyData = await chrome.storage.local.get(tidyKey);
            const prev = getTidyState(tidyData, tidyKey);
            const sections = prev.sections.map((s) =>
              s.name === oldName ? { ...s, name: newName } : s,
            );
            await chrome.storage.local.set({
              [tidyKey]: { ...prev, sections },
            });
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_ARCHIVE_SECTION") {
        (async () => {
          try {
            const { tabIds } = message as { type: string; tabIds: number[] };
            if (!tabIds.length) { sendResponse({ ok: false }); return; }
            const closedTabs = await Promise.all(
              tabIds.map(async (id) => {
                try {
                  const tab = await chrome.tabs.get(id);
                  return { id: tab.id!, url: tab.url ?? "", title: tab.title ?? "", windowId: tab.windowId };
                } catch { return null; }
              }),
            );
            const validClosed = closedTabs.filter(Boolean) as { id: number; url: string; title: string; windowId: number }[];
            await chrome.tabs.remove(validClosed.map((t) => t.id));
            sendResponse({
              ok: true,
              undo: { action: "reopen", tabs: validClosed.map((t) => ({ url: t.url, windowId: t.windowId })) },
            });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_REORDER_TABS") {
        (async () => {
          try {
            const { tabId, overTabId, sectionChange } = message as {
              type: string;
              tabId: number;
              overTabId: number;
              sectionChange: string | null;
            };
            const overTab = await chrome.tabs.get(overTabId);
            await chrome.tabs.move(tabId, { index: overTab.index });

            if (sectionChange !== null && sectionChange !== undefined) {
              const { storage } = await import("@/lib/storage");
              const wId = sender.tab?.windowId;
              if (wId) {
                const space = await storage.getSpaceByWindowId(wId);
                if (space) {
                  const tidyKey = `_tidyState:${space.id}`;
                  const tidyData = await chrome.storage.local.get(tidyKey);
                  const prev = getTidyState(tidyData, tidyKey);
                  const sectionEntry = prev.sections.find(
                    (s) => s.name === sectionChange,
                  );
                  const newAssignments = { ...prev.tabAssignments };
                  if (sectionEntry) {
                    newAssignments[tabId] = sectionEntry.id;
                  } else {
                    delete newAssignments[tabId];
                  }
                  await chrome.storage.local.set({
                    [tidyKey]: { ...prev, tabAssignments: newAssignments },
                  });
                }
              }
            }
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_REORDER_FAVORITES") {
        (async () => {
          try {
            const { url, overUrl } = message as {
              type: string;
              url: string;
              overUrl: string;
            };
            const { storage } = await import("@/lib/storage");
            const wId = sender.tab?.windowId;
            if (!wId) { sendResponse({ ok: false }); return; }
            const space = await storage.getSpaceByWindowId(wId);
            if (!space) { sendResponse({ ok: false }); return; }

            const favs = [...space.favorites];
            const fromIdx = favs.findIndex((f) => f.url === url);
            const toIdx = favs.findIndex((f) => f.url === overUrl);
            if (fromIdx === -1 || toIdx === -1) { sendResponse({ ok: false }); return; }

            const [moved] = favs.splice(fromIdx, 1);
            const insertIdx = favs.findIndex((f) => f.url === overUrl);
            favs.splice(insertIdx, 0, moved);
            favs.forEach((f, i) => { f.position = i; });

            await storage.updateSpace(space.id, { favorites: favs });
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "GENERATE_TAB_TITLE") {
        (async () => {
          try {
            const { tabId } = message as { type: string; tabId: number };
            const tab = await chrome.tabs.get(tabId);
            const { storage } = await import("@/lib/storage");
            const wId = sender.tab?.windowId;
            if (!wId) { sendResponse({ ok: false }); return; }
            const space = await storage.getSpaceByWindowId(wId);
            if (!space) { sendResponse({ ok: false }); return; }

            const { enrichWithSettings } = await import("./auto-tidy");
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const enriched = await enrichWithSettings({
              type: "SORT_TABS",
              tabs: [{ id: String(tabId), url: tab.url ?? "", title: tab.title ?? "Untitled" }],
            });
            const result = (await sendToOffscreen(enriched)) as SortResult & { error?: string };

            let tidiedTitle: string | null = null;
            if (result && !result.error) {
              if (result.tabs?.[0]?.tidiedTitle) {
                tidiedTitle = result.tabs[0].tidiedTitle;
              } else if (result.sections?.[0]?.tabs?.[0]?.tidiedTitle) {
                tidiedTitle = result.sections[0].tabs[0].tidiedTitle;
              }
            }

            if (tidiedTitle) {
              const tidyKey = `_tidyState:${space.id}`;
              const tidyData = await chrome.storage.local.get(tidyKey);
              const prev = getTidyState(tidyData, tidyKey);
              await chrome.storage.local.set({
                [tidyKey]: {
                  ...prev,
                  tidiedTitles: { ...prev.tidiedTitles, [tabId]: tidiedTitle },
                },
              });
            }

            sendResponse({ ok: true, tidiedTitle });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "GENERATE_CHAT_TITLE") {
        (async () => {
          try {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = await sendToOffscreen({
              type: "GENERATE_CHAT_TITLE",
              providerId: message.providerId,
              config: message.config,
              modelId: message.modelId,
              userMessage: message.userMessage,
            });
            sendResponse(result);
          } catch (err) {
            sendResponse({ error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_PIN_FAVORITE") {
        (async () => {
          try {
            const url = message.url as string;
            const windowId = sender.tab?.windowId;
            let tabId: number | undefined;
            if (windowId) {
              const tabs = await chrome.tabs.query({ windowId });
              const existing = tabs.find((t) => t.url === url);
              if (existing?.id) {
                tabId = existing.id;
              }
            }
            if (!tabId) {
              const created = await chrome.tabs.create({ url, windowId: windowId || undefined });
              tabId = created.id!;
            }
            await chrome.tabs.update(tabId, { pinned: true });
            const { storage } = await import("@/lib/storage");
            let prevFavorites: any[] | undefined;
            let spaceId: string | undefined;
            if (windowId) {
              const space = await storage.getSpaceByWindowId(windowId);
              if (space) {
                prevFavorites = [...space.favorites];
                spaceId = space.id;
                const updated = space.favorites.filter((f) => f.url !== url);
                if (updated.length !== space.favorites.length) {
                  await storage.updateSpace(space.id, { favorites: updated });
                }
              }
            }
            sendResponse({ ok: true, undo: { action: "pin", tabId, prevFavorites, spaceId } });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_OPEN_URL") {
        (async () => {
          try {
            const url = message.url as string;
            const source = message.source as string | undefined;
            const sessionId = (message as { sessionId?: string }).sessionId;
            const windowId = sender.tab?.windowId;
            let focusedTabId: number | undefined;

            // If a sessionId is provided (true Recently Closed), restore via sessions API
            // — this preserves scroll, history, etc.
            if (sessionId) {
              try {
                const restored = await chrome.sessions.restore(sessionId);
                if (restored?.tab?.id) {
                  focusedTabId = restored.tab.id;
                }
              } catch {
                // fall through to URL-based open
              }
            }

            if (!focusedTabId && windowId) {
              const tabs = await chrome.tabs.query({ windowId });
              const existing = tabs.find((t) => t.url === url);
              if (existing?.id) {
                await chrome.tabs.update(existing.id, { active: true });
                focusedTabId = existing.id;
              }
            }
            if (!focusedTabId) {
              const created = await chrome.tabs.create({ url, windowId: windowId || undefined });
              focusedTabId = created.id!;
            }
            if (source === "favorite" && windowId && focusedTabId) {
              const { storage } = await import("@/lib/storage");
              const space = await storage.getSpaceByWindowId(windowId);
              if (space) {
                const { associate } = await import("./favorite-tabs");
                const tab = await chrome.tabs.get(focusedTabId);
                associate(space.id, url, focusedTabId, tab.url ?? url, tab.title ?? url, tab.favIconUrl ?? "");
              }
            }
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OVERLAY_GLOBAL_ACTION") {
        (async () => {
          try {
            const { action } = message as { type: string; action: string };
            const windowId = sender.tab?.windowId ?? (message as { windowId?: number }).windowId;

            if (action === "clean") {
              if (!windowId) {
                sendResponse({ ok: false, error: "No window" });
                return;
              }
              const { storage } = await import("@/lib/storage");
              const { getAssociatedTabIds: getCleanFavTabIds } = await import("./favorite-tabs");
              const space = await storage.getSpaceByWindowId(windowId);
              const favTabIds = space ? getCleanFavTabIds(space.id) : new Set<number>();
              const favoriteUrls = new Set(space?.favorites.map((f) => f.url) ?? []);
              const homeUrl = chrome.runtime.getURL("/home.html");
              const sidepanelUrl = chrome.runtime.getURL("/sidepanel.html");
              const overlayUrl = chrome.runtime.getURL("/overlay.html");
              const isExtPage = (url?: string) =>
                !url || url.startsWith(homeUrl) || url.startsWith(sidepanelUrl) || url.startsWith(overlayUrl);

              const tabs = await chrome.tabs.query({ windowId });
              const toClose = tabs.filter(
                (t) => t.id && !t.pinned && !isExtPage(t.url) && !favTabIds.has(t.id!) && !favoriteUrls.has(t.url ?? ""),
              );
              if (toClose.length > 0) {
                const closedUrls = toClose.map((t) => t.url!).filter(Boolean);
                await chrome.tabs.remove(toClose.map((t) => t.id!));
                sendResponse({ ok: true, undo: { action: "clean", closedUrls, windowId }, closedCount: toClose.length });
                return;
              }
            } else if (action === "new-space") {
              const { createSpace, focusOrCreateWindow } = await import("./spaces");
              const { spaceName, spaceIcon } = message as { spaceName?: string; spaceIcon?: string | null };
              const space = await createSpace(spaceName || "New Space", spaceIcon ?? null);
              await focusOrCreateWindow(space);
            } else if (action === "full-view") {
              const homeUrl = chrome.runtime.getURL("/home.html");
              const hash = (message as { hash?: string }).hash || "";
              const existingTabs = await chrome.tabs.query({
                url: homeUrl + "*",
                ...(windowId ? { windowId } : {}),
              });
              const pinned = existingTabs.find((t) => t.pinned);
              const target = pinned || existingTabs[0];
              if (target?.id) {
                await chrome.tabs.update(target.id, { active: true, url: homeUrl + hash });
              } else {
                const tab = await chrome.tabs.create({
                  url: homeUrl + hash,
                  pinned: true,
                  ...(windowId ? { windowId } : {}),
                });
                if (tab.id) await chrome.tabs.move(tab.id, { index: 0 });
              }
            } else if (action === "settings") {
              await chrome.tabs.create({
                url: chrome.runtime.getURL("/settings.html"),
                ...(windowId ? { windowId } : {}),
              });
            } else if (action === "history") {
              // Handled entirely in the frontend
            } else if (action === "tidy") {
              if (!windowId) {
                sendResponse({ ok: false, error: "No window" });
                return;
              }
              // Respond immediately — tidy runs in background
              sendResponse({ ok: true });
              runOverlayTidy(windowId).catch(() => {});
              return;
            }

            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "DETACH_SIDEPANEL") {
        (async () => {
          try {
            const m = message as {
              type: string;
              activeConversationId?: string | null;
              activeSpaceId?: string | null;
              originWindowId?: number | null;
              originTabId?: number | null;
              originUrl?: string | null;
            };
            const originWindowId =
              m.originWindowId ??
              sender.tab?.windowId ??
              lastFocusedWindowId ??
              (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;

            // Resolve origin tab if not provided, by looking up the active
            // tab in the origin window.
            let originTabId = m.originTabId ?? null;
            let originUrl = m.originUrl ?? null;
            if (originTabId == null && originWindowId != null) {
              try {
                const [tab] = await chrome.tabs.query({ active: true, windowId: originWindowId });
                if (tab?.id != null) {
                  originTabId = tab.id;
                  originUrl = tab.url ?? null;
                }
              } catch {}
            }

            // Close the side panel on the origin tab. With no global panel
            // declared in the manifest, this is the only kind of panel that
            // can exist for this extension.
            const closePanel = chrome.sidePanel.close;
            if (closePanel && originTabId != null) {
              markUserClosedSidePanel(originTabId);
              closePanel({ tabId: originTabId }).catch(() => {});
              chrome.sidePanel
                .setOptions({ tabId: originTabId, path: "sidepanel.html", enabled: false })
                .catch(() => {});
            }

            const params = new URLSearchParams({ mode: "popup" });
            if (originWindowId != null) params.set("originWindowId", String(originWindowId));
            if (originTabId != null) params.set("originTabId", String(originTabId));
            if (originUrl) params.set("originUrl", originUrl);
            if (m.activeConversationId) params.set("conversationId", m.activeConversationId);

            const popupWindow = await chrome.windows.create({
              type: "popup",
              url: chrome.runtime.getURL(`/sidepanel.html?${params.toString()}`),
              width: 420,
              height: 700,
              focused: true,
            });
            void popupWindow;
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "OPEN_SIDEPANEL_SEARCH") {
        (async () => {
          try {
            const windowId = sender.tab?.windowId ?? lastFocusedWindowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
            if (windowId) {
              chrome.storage.session.set({ focusSearch: true });
              const tabId = sender.tab?.id ?? activeTabByWindow.get(windowId);
              if (tabId != null) openSidePanelOnTab(tabId);
            }
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "MARK_USER_OPENED_SIDEPANEL") {
        const tabId = message.tabId as number | undefined;
        if (tabId != null) markUserOpenedSidePanel(tabId);
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "OPEN_NEW_SPACE_OVERLAY" || message.type === "OPEN_OVERLAY_ACTION") {
        const action = message.action ?? "new-space";
        (async () => {
          try {
            const windowId = sender.tab?.windowId ?? lastFocusedWindowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
            if (!windowId) { sendResponse({ ok: false }); return; }
            const [tab] = await chrome.tabs.query({ active: true, windowId });
            if (!tab?.id) { sendResponse({ ok: false }); return; }
            const homeUrl = chrome.runtime.getURL("/home.html");
            if (tab.url?.startsWith(homeUrl)) {
              chrome.runtime.sendMessage({ type: "TOGGLE_HOME_OVERLAY", action });
            } else {
              await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_OVERLAY", action });
            }
            sendResponse({ ok: true });
          } catch {
            sendResponse({ ok: false });
          }
        })();
        return true;
      }

      if (message.type === "DELETE_SPACE") {
        (async () => {
          try {
            const { storage } = await import("@/lib/storage");
            const spaces = await storage.getSpaces();
            const deletedSpace = spaces.find((s) => s.id === message.spaceId);
            const updated = spaces.filter((s) => s.id !== message.spaceId);
            await storage.setSpaces(updated);

            const targetWindowId = deletedSpace?.windowId ?? null;

            // Switch to another space first (before closing the window)
            if (updated.length > 0) {
              const { switchToSpaceById } = await import("./spaces");
              const withWindow = updated.find(
                (s) => s.windowId !== null && s.windowId !== targetWindowId
              );
              await switchToSpaceById(withWindow ? withWindow.id : updated[0].id);
            }

            // Close the deleted space's window after switching
            if (targetWindowId !== null) {
              try {
                await chrome.windows.remove(targetWindowId);
              } catch {
                // window may already be closed
              }
            }

            sendResponse({ ok: true });
          } catch {
            sendResponse({ ok: false });
          }
        })();
        return true;
      }

      if (message.type === "SWITCH_SPACE_BY_POSITION") {
        import("./spaces")
          .then(async ({ switchToSpace }) => {
            await switchToSpace(message.position);
            sendResponse({ ok: true });
          })
          .catch(() => sendResponse({ ok: false }));
        return true;
      }

      if (message.type === "SWITCH_SPACE") {
        import("./spaces")
          .then(async ({ switchToSpaceById }) => {
            await switchToSpaceById(message.spaceId);
            if (message.openSidePanel) {
              const { storage } = await import("@/lib/storage");
              const spaces = await storage.getSpaces();
              const space = spaces.find((s) => s.id === message.spaceId);
              if (space?.windowId) {
                const tabId = activeTabByWindow.get(space.windowId);
                if (tabId != null) openSidePanelOnTab(tabId);
              }
            }
            sendResponse({ ok: true });
          })
          .catch(() => sendResponse({ ok: false }));
        return true;
      }

      if (message.type === "CHAT_READ_PAGE") {
        import("./chat-tools").then(({ executeReadPage }) => {
          executeReadPage(message.tabId).then(sendResponse);
        });
        return true;
      }

      if (message.type === "AGENT_TAB_WORKING" || message.type === "AGENT_TAB_IDLE") {
        const working = message.type === "AGENT_TAB_WORKING";
        const tabId = message.tabId as number | undefined;
        if (tabId) {
          agentWorkingTabId = working ? tabId : null;
          agentWorkingColor = working ? (message.color ?? null) : null;
        }
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "AGENT_STATUS_CHECK") {
        sendResponse({ working: agentWorkingTabId === sender.tab?.id });
        return false;
      }

      if (message.type === "AGENT_STOP") {
        agentWorkingTabId = null;
        sendResponse({ ok: true });
        return false;
      }

      if (message.type === "CHAT_SCREENSHOT") {
        import("./chat-tools").then(({ executeScreenshot }) => {
          executeScreenshot().then(sendResponse);
        });
        return true;
      }

      if (message.type === "CHAT_LIST_TABS") {
        import("./chat-tools").then(({ listSpaceTabs }) => {
          listSpaceTabs(message.windowId).then(sendResponse);
        });
        return true;
      }

      if (message.type === "DOWNLOAD_BROWSER_AI") {
        (async () => {
          try {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = await sendToOffscreen(message);
            sendResponse(result);
          } catch (err) {
            sendResponse({ error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "DOWNLOAD_MODEL") {
        (async () => {
          try {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = (await sendToOffscreen(message)) as { success?: boolean; error?: string };
            if (result?.success) {
              const { storage } = await import("@/lib/storage");
              await storage.addDownloadedModel(message.modelId);
            }
            sendResponse(result);
          } catch (err) {
            sendResponse({ error: String(err) });
          }
        })();
        return true;
      }

      if (message.type === "DELETE_MODEL") {
        (async () => {
          try {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = (await sendToOffscreen(message)) as { success?: boolean; error?: string };
            if (result?.success) {
              const { storage } = await import("@/lib/storage");
              await storage.removeDownloadedModel(message.modelId);
            }
            sendResponse(result);
          } catch (err) {
            sendResponse({ error: String(err) });
          }
        })();
        return true;
      }
    });

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === "sidepanel") {
        let panelWindowId: number | undefined;
        const portMsgHandler = (msg: unknown) => {
          if (
            msg &&
            typeof msg === "object" &&
            (msg as { type?: string }).type === "SIDEPANEL_HELLO"
          ) {
            const wid = (msg as { windowId?: number }).windowId;
            if (typeof wid === "number") {
              panelWindowId = wid;
              import("./tab-scoping").then(({ setSidePanelOpen }) => {
                setSidePanelOpen(wid, true);
              });
            }
          }
        };
        port.onMessage.addListener(portMsgHandler);
        port.onDisconnect.addListener(() => {
          if (panelWindowId != null) {
            import("./tab-scoping").then(({ setSidePanelOpen }) => {
              setSidePanelOpen(panelWindowId!, false);
            });
          }
        });
        return;
      }

      if (port.name === "tidy-progress") {
        port.onMessage.addListener((msg) => {
          chrome.storage.local.set({ _tidyProgress: msg });
        });
        return;
      }

      if (port.name !== "settings") return;

      port.onMessage.addListener(async (message) => {
        const id = message._id;
        const reply = (data: unknown) => {
          try {
            port.postMessage({ _id: id, data });
          } catch {}
        };

        try {
          if (message.type === "CHECK_AVAILABILITY") {
            if (message.provider === "web-llm" && message.webllmModel) {
              const { storage } = await import("@/lib/storage");
              const downloaded = await storage.getDownloadedModels();
              if (downloaded.includes(message.webllmModel)) {
                reply({
                  provider: message.provider,
                  availability: "available",
                  message: `${message.webllmModel} downloaded — ready to load`,
                });
                return;
              }
            }
            // For cloud provider, use cloudConfig from message if present, fallback to storage
            let enrichedMsg = { ...message };
            if (message.provider === "cloud" && !message.cloudConfig) {
              const { storage } = await import("@/lib/storage");
              const settings = await storage.getSettings();
              enrichedMsg.cloudConfig = {
                cloudProvider: settings.cloudProvider,
                cloudApiKey: settings.cloudApiKey,
                cloudModel: settings.cloudModel,
                cloudBaseUrl: settings.cloudBaseUrl,
              };
            }
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = (await sendToOffscreen(enrichedMsg)) as ModelStatus;
            if (
              result?.availability === "available" &&
              message.provider === "web-llm" &&
              message.webllmModel
            ) {
              const { storage } = await import("@/lib/storage");
              await storage.addDownloadedModel(message.webllmModel);
            }
            reply(result);
          } else if (message.type === "TEST_CONNECTION") {
            // For cloud provider, use cloudConfig from message if present, fallback to storage
            let enrichedMsg = { ...message };
            if (message.provider === "cloud" && !message.cloudConfig) {
              const { storage } = await import("@/lib/storage");
              const settings = await storage.getSettings();
              enrichedMsg.cloudConfig = {
                cloudProvider: settings.cloudProvider,
                cloudApiKey: settings.cloudApiKey,
                cloudModel: settings.cloudModel,
                cloudBaseUrl: settings.cloudBaseUrl,
              };
            }
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = (await sendToOffscreen(enrichedMsg)) as { success?: boolean; error?: string };
            if (
              result?.success &&
              message.provider === "web-llm" &&
              message.webllmModel
            ) {
              const { storage } = await import("@/lib/storage");
              await storage.addDownloadedModel(message.webllmModel);
            }
            reply(result);
          } else if (message.type === "DOWNLOAD_MODEL") {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = (await sendToOffscreen(message)) as { success?: boolean; error?: string };
            if (result?.success) {
              const { storage } = await import("@/lib/storage");
              await storage.addDownloadedModel(message.modelId);
            }
            reply(result);
          } else if (message.type === "DOWNLOAD_BROWSER_AI") {
            // #region DEBUG
            console.log("[DEBUG H5] background received DOWNLOAD_BROWSER_AI");
            // #endregion DEBUG
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            // #region DEBUG
            console.log("[DEBUG H5] offscreen document ensured, sending to offscreen");
            // #endregion DEBUG
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = (await sendToOffscreen(message)) as { success?: boolean; error?: string };
            // #region DEBUG
            console.log("[DEBUG H5] offscreen result:", result);
            // #endregion DEBUG
            reply(result);
          } else if (message.type === "DELETE_MODEL") {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = (await sendToOffscreen(message)) as { success?: boolean; error?: string };
            if (result?.success) {
              const { storage } = await import("@/lib/storage");
              await storage.removeDownloadedModel(message.modelId);
            }
            reply(result);
          } else if (message.type === "CHECK_MODEL_CACHE") {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { sendToOffscreen } = await import("@/lib/messages");
            const result = await sendToOffscreen(message);
            reply(result);
          } else if (message.type === "SORT_TABS") {
            const { ensureOffscreenDocument } = await import("./messages");
            await ensureOffscreenDocument();
            const { storage } = await import("@/lib/storage");
            const settings = await storage.getSettings();
            const enriched = {
              ...message,
              provider: settings.aiProvider,
              modelId:
                settings.aiProvider === "cloud"
                  ? settings.cloudModel
                  : settings.webllmModel,
              ...(settings.aiProvider === "cloud"
                ? {
                    cloudConfig: {
                      cloudProvider: settings.cloudProvider,
                      cloudApiKey: settings.cloudApiKey,
                      cloudModel: settings.cloudModel,
                      cloudBaseUrl: settings.cloudBaseUrl,
                    },
                  }
                : {}),
            };
            // #region DEBUG
            await (
              await import("@/lib/debug-log")
            ).debugLog(
              `[DEBUG H2] bg ${message.type} provider=${settings.aiProvider} model=${settings.aiProvider === "cloud" ? settings.cloudModel : settings.webllmModel}`,
            );
            // #endregion DEBUG
            const { sendToOffscreen } = await import("@/lib/messages");
            let result: { error?: string; [key: string]: unknown };
            try {
              result = (await sendToOffscreen(enriched)) as { error?: string; [key: string]: unknown };
              // #region DEBUG
              await (
                await import("@/lib/debug-log")
              ).debugLog(
                `[DEBUG H2] offscreen returned: ${JSON.stringify(result)?.slice(0, 500)}`,
              );
              // #endregion DEBUG
            } catch (err: unknown) {
              // #region DEBUG
              await (
                await import("@/lib/debug-log")
              ).debugLog(
                `[DEBUG H2] offscreen threw: ${err instanceof Error ? err.message : String(err)}`,
              );
              // #endregion DEBUG
              result = { error: String(err) };
            }
            // Persist result so UI can recover if port disconnects
            if (message.type === "SORT_TABS" && result && !result.error) {
              await chrome.storage.local.set({
                _sortResult: { result, timestamp: Date.now() },
              });
            }
            reply(result);
          } else if (message.type === "OPEN_OR_FOCUS_TAB") {
            const url = message.url as string;
            const source = message.source as string | undefined;
            const focusedWindows = await chrome.windows.getAll({
              populate: false,
            });
            const focused = focusedWindows.find((w) => w.focused);
            const windowId = focused?.id;
            let resultTabId: number | undefined;
            let action: "focused" | "opened" = "opened";

            if (windowId) {
              const tabs = await chrome.tabs.query({ windowId });
              const existing = tabs.find((t) => t.url === url);
              if (existing?.id) {
                await chrome.tabs.update(existing.id, { active: true });
                resultTabId = existing.id;
                action = "focused";
              }
            }

            if (!resultTabId) {
              const created = await chrome.tabs.create({ url, windowId: windowId || undefined });
              resultTabId = created.id!;
            }

            if (source === "favorite" && windowId && resultTabId) {
              const { storage } = await import("@/lib/storage");
              const space = await storage.getSpaceByWindowId(windowId);
              if (space) {
                const { associate } = await import("./favorite-tabs");
                const tab = await chrome.tabs.get(resultTabId);
                associate(space.id, url, resultTabId, tab.url ?? url, tab.title ?? url, tab.favIconUrl ?? "");
              }
            }

            reply({ ok: true, action });
          } else if (message.type === "PIN_TAB") {
            const url = message.url as string;
            const focusedWindows = await chrome.windows.getAll({
              populate: false,
            });
            const focused = focusedWindows.find((w) => w.focused);
            if (focused?.id) {
              const tabs = await chrome.tabs.query({ windowId: focused.id });
              const tab = tabs.find((t) => t.url === url);
              if (tab?.id) {
                await chrome.tabs.update(tab.id, { pinned: true });
                reply({ ok: true });
                return;
              }
            }
            reply({ ok: false, reason: "tab not found" });
          } else if (message.type === "UNPIN_TAB") {
            const url = message.url as string;
            const focusedWindows = await chrome.windows.getAll({
              populate: false,
            });
            const focused = focusedWindows.find((w) => w.focused);
            if (focused?.id) {
              const tabs = await chrome.tabs.query({
                windowId: focused.id,
                pinned: true,
              });
              const tab = tabs.find((t) => t.url === url);
              if (tab?.id) {
                await chrome.tabs.update(tab.id, { pinned: false });
                reply({ ok: true });
                return;
              }
            }
            reply({ ok: false, reason: "tab not found" });
          } else if (message.type === "DEBUG_ECHO") {
            reply({ echo: true, got: message });
          } else {
            reply({ error: "Unknown message type" });
          }
        } catch (err) {
          reply({ error: String(err) });
        }
      });
    });

    chrome.notifications.onClicked.addListener(async (notificationId) => {
      const info = pendingNotifications.get(notificationId);
      if (!info) return;
      pendingNotifications.delete(notificationId);
      chrome.notifications.clear(notificationId);
      if (info.origin === "sidepanel") {
        const windowId = lastFocusedWindowId ?? (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
        if (windowId) {
          const tabId = activeTabByWindow.get(windowId);
          if (tabId != null) openSidePanelOnTab(tabId);
        }
      } else {
        const homeUrl = chrome.runtime.getURL("/home.html");
        const [existing] = await chrome.tabs.query({ url: homeUrl + "*" });
        if (existing?.id) {
          chrome.tabs.update(existing.id, { active: true });
          if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true });
        } else {
          chrome.tabs.create({ url: homeUrl });
        }
      }
    });

    chrome.windows.onRemoved.addListener(async (windowId) => {
      const { storage } = await import("@/lib/storage");
      const space = await storage.getSpaceByWindowId(windowId);
      if (space) {
        await storage.updateSpace(space.id, { windowId: null });
      }
    });

    import("./favorite-tabs").then(({ bootstrap }) => {
      import("@/lib/storage").then(({ storage }) =>
        storage.getSpaces().then((spaces) => bootstrap(spaces)),
      );
    });

    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (changeInfo.url || changeInfo.title || changeInfo.favIconUrl) {
        import("./favorite-tabs").then(({ updateTabInfo }) => {
          updateTabInfo(tab.id!, changeInfo.url, changeInfo.title, changeInfo.favIconUrl);
        });
      }
      if (changeInfo.status === "complete" && tab.id != null && tab.id === agentWorkingTabId) {
        import("@/lib/agent/agent-transport").then(({ injectIndicator }) => {
          injectIndicator(tab.id!, agentWorkingColor);
        }).catch(() => {});
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      import("./favorite-tabs").then(({ disassociateByTab }) => {
        disassociateByTab(tabId);
      });
    });

    import("./auto-tidy").then(({ startAutoTidy }) => {
      startAutoTidy();
    });

    function updateIcon(isDark: boolean) {
      chrome.action.setIcon({
        path: isDark
          ? { 16: "icon/16-dark.png", 32: "icon/32-dark.png", 48: "icon/48-dark.png", 128: "icon/128-dark.png" }
          : { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
      });
    }

    chrome.storage.local.get("theme-is-dark").then((result) => {
      updateIcon(result["theme-is-dark"] === true);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes["theme-is-dark"]) {
        updateIcon(changes["theme-is-dark"].newValue === true);
      }
    });

  },
});
