import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTidyProgress } from "./hooks/useTidyProgress";
import type { AutoTidyNotification, FavoriteTabAssociation, Space, TidyState } from "@/lib/types";
import { storage } from "@/lib/storage";
import { useTheme } from "@/hooks/useTheme";
import { OverlayHeader } from "./components/OverlayHeader";
import { OverlayTabList, type ReorderEvent } from "./components/OverlayTabList";
import { OverlayActionList, useFilteredActions } from "./components/OverlayActionList";
import { OverlayFooter } from "./components/OverlayFooter";
import { CreateSpaceForm } from "./components/CreateSpaceForm";
import { ConfigureSpaceView } from "./components/ConfigureSpaceView";
import { SpaceColorPicker } from "./components/SpaceColorPicker";
import { AutoTidyBanner } from "./components/AutoTidyBanner";
import { adjustColorsForMode, buildGradientBorder } from "@/lib/color-utils";

export interface OverlayTab {
  id: number;
  url: string;
  title: string;
  favicon: string;
  pinned: boolean;
  active: boolean;
  windowId: number;
  spaceName?: string;
  spaceIcon?: string;
  sectionName?: string;
  searchTitles?: string[];
  kind: "tab" | "favorite" | "closed" | "bookmark";
  lastVisitTime?: number;
  visitCount?: number;
}

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return 1000 + (q.length / t.length) * 100;

  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let lastMatchIdx = -2;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive = ti === lastMatchIdx + 1 ? consecutive + 1 : 1;
      score += consecutive * 2;
      if (ti === 0 || t[ti - 1] === "/" || t[ti - 1] === "." || t[ti - 1] === " " || t[ti - 1] === "-") {
        score += 5;
      }
      lastMatchIdx = ti;
    }
  }

  return qi === q.length ? score : 0;
}

function frecencyScore(tab: { lastVisitTime?: number; visitCount?: number }): number {
  const visits = tab.visitCount ?? 1;
  const ageMs = Date.now() - (tab.lastVisitTime ?? 0);
  const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 0.1);
  return visits / ageDays;
}

function closeOverlay() {
  window.parent.postMessage({ type: "OPENBROWSE_OVERLAY_CLOSE" }, "*");
}

function showToast(message: string, undoData?: any) {
  window.parent.postMessage({ type: "OPENBROWSE_TOAST", message, undoData }, "*");
}

export function OverlayApp() {
  useTheme();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<number | null>(null);
  const [tabs, setTabs] = useState<OverlayTab[]>([]);
  const [allTabs, setAllTabs] = useState<OverlayTab[]>([]);
  const [query, setQuery] = useState("");
  const [focusIndex, setFocusIndex] = useState(0);
  const [isActionMode, setIsActionMode] = useState(false);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<number | null>(null);
  const [generatingTitles, setGeneratingTitles] = useState<Set<number>>(new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const tidyProgress = useTidyProgress();
  const isTidying = tidyProgress !== "";
  const inputRef = useRef<HTMLInputElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const createSpaceSubmitRef = useRef<(() => void) | null>(null);
  const [recentlyClosed, setRecentlyClosed] = useState<OverlayTab[]>([]);
  const [historySearchResults, setHistorySearchResults] = useState<OverlayTab[]>([]);
  const [bookmarks, setBookmarks] = useState<OverlayTab[]>([]);
  const [favoriteAssociationsList, setFavoriteAssociationsList] = useState<FavoriteTabAssociation[]>([]);
  const [historyMode, setHistoryMode] = useState(false);
  const [configuringSpace, setConfiguringSpace] = useState(false);
  const [editingColor, setEditingColor] = useState(false);
  const spaceIdOverridden = useRef(false);
  const [previewColors, setPreviewColors] = useState<string[] | null>(null);
  const [previewColorMode, setPreviewColorMode] = useState<"auto" | "light" | "dark" | null>(null);
  const [autoTidyNotification, setAutoTidyNotification] = useState<AutoTidyNotification | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "OVERLAY_READY" }).then((res) => {
      if (res?.ok) {
        setSpaces(res.spaces ?? []);
        setActiveSpaceId(res.activeSpaceId ?? null);
        setWindowId(res.windowId ?? null);
        if (res.autoTidyNotification) {
          setAutoTidyNotification(res.autoTidyNotification);
        }
      }
      const params = new URLSearchParams(window.location.search);
      if (params.get("action") === "new-space") {
        setCreatingSpace(true);
      } else if (params.get("action") === "configure-space") {
        setConfiguringSpace(true);
        const targetSpaceId = params.get("spaceId");
        if (targetSpaceId) {
          setActiveSpaceId(targetSpaceId);
          spaceIdOverridden.current = true;
        }
      }
      setReady(true);
    });
  }, []);

  const [tidyState, setTidyState] = useState<TidyState | null>(null);

  const fetchTabs = useCallback(() => {
    if (windowId === null) return;
    chrome.runtime.sendMessage({ type: "GET_OVERLAY_TABS", windowId }).then((res) => {
      if (res?.ok) {
        setTabs(res.tabs ?? []);
        setAllTabs(res.allTabs ?? []);
        if (res.tidyState) setTidyState(res.tidyState);
        if (res.spaces) setSpaces(res.spaces);
        if (res.activeSpaceId && !spaceIdOverridden.current) setActiveSpaceId(res.activeSpaceId);
        setRecentlyClosed(
          (res.recentlyClosed ?? []).map((rc: { url: string; title: string; favicon: string; lastVisitTime: number; visitCount: number }) => ({
            id: -1,
            url: rc.url,
            title: rc.title,
            favicon: rc.favicon,
            pinned: false,
            active: false,
            windowId: windowId ?? -1,
            kind: "closed" as const,
            lastVisitTime: rc.lastVisitTime,
            visitCount: rc.visitCount,
          })),
        );
        setFavoriteAssociationsList(res.favoriteAssociations ?? []);
        setBookmarks(
          (res.bookmarks ?? []).map((b: { url: string; title: string; favicon: string }) => ({
            id: -1,
            url: b.url,
            title: b.title,
            favicon: b.favicon,
            pinned: false,
            active: false,
            windowId: windowId ?? -1,
            kind: "bookmark" as const,
          })),
        );
      }
    });
  }, [windowId]);

  useEffect(() => { fetchTabs(); }, [fetchTabs]);

  useEffect(() => {
    if (tidyProgress === "done") {
      fetchTabs();
      chrome.runtime.sendMessage({ type: "GET_TIDY_STATS" }).then((res) => {
        if (res?.ok) {
          setAutoTidyNotification({
            timestamp: Date.now(),
            archivedCount: res.archivedCount ?? 0,
            sectionCount: res.sectionCount ?? 0,
            tabCount: res.tabCount ?? 0,
          });
        }
      });
    }
  }, [tidyProgress, fetchTabs]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "OPENBROWSE_UNDO_COMPLETE") fetchTabs();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [fetchTabs]);

  useEffect(() => {
    if (ready) inputRef.current?.focus();
  }, [ready]);

  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    const observer = new ResizeObserver(() => {
      const height = Math.max(root.scrollHeight, document.body.scrollHeight);
      window.parent.postMessage({ type: "OPENBROWSE_OVERLAY_RESIZE", height }, "*");
    });
    observer.observe(root);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  const actionItems = useFilteredActions(query, spaces);

  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const activeSpace = spaces.find((s) => s.id === activeSpaceId) ?? null;

  const [activeSpaceTabCount, setActiveSpaceTabCount] = useState(0);

  useEffect(() => {
    if (!configuringSpace || !activeSpace) {
      setActiveSpaceTabCount(0);
      return;
    }
    if (activeSpace.windowId !== null) {
      chrome.tabs.query({ windowId: activeSpace.windowId }).then((t) => {
        const nonPinned = t.filter((tab) => !tab.pinned);
        setActiveSpaceTabCount(nonPinned.length);
      }).catch(() => setActiveSpaceTabCount(0));
    } else {
      setActiveSpaceTabCount(0);
    }
  }, [configuringSpace, activeSpace]);

  const themedStyles = useMemo(() => {
    const colors = editingColor ? previewColors : activeSpace?.colors;
    const mode = editingColor ? previewColorMode : activeSpace?.colorMode;
    if (!colors) return null;
    const adjusted = adjustColorsForMode(
      colors,
      mode ?? "auto",
      systemDark,
    );
    return {
      borderGradient: buildGradientBorder(adjusted),
    };
  }, [activeSpace?.colors, activeSpace?.colorMode, editingColor, previewColors, previewColorMode, systemDark]);
  const otherSpaces = useMemo(
    () => spaces.filter((s) => s.id !== activeSpaceId),
    [spaces, activeSpaceId],
  );
  const favoriteUrls = useMemo(
    () => new Set(activeSpace?.favorites.map((f) => f.url) ?? []),
    [activeSpace],
  );
  const associatedTabIds = useMemo(
    () => new Set(favoriteAssociationsList.map((a) => a.tabId)),
    [favoriteAssociationsList],
  );
  const favoriteAssociationsMap = useMemo(
    () => new Map(favoriteAssociationsList.map((a) => [a.favoriteUrl, a])),
    [favoriteAssociationsList],
  );

  const handleQueryChange = useCallback((value: string) => {
    if (!isActionMode && value.startsWith("/")) {
      setIsActionMode(true);
      setQuery(value.slice(1));
      setFocusIndex(0);
      return;
    }
    setQuery(value);
  }, [isActionMode]);

  const sectionById = useMemo(() => {
    const map = new Map<string, string>();
    if (tidyState) {
      for (const s of tidyState.sections) map.set(s.id, s.name);
    }
    return map;
  }, [tidyState]);

  const enrichedTabs = useMemo(() => {
    const baseTabs = query.trim()
      ? [...tabs, ...allTabs]
      : tabs;
    return baseTabs.map((t) => {
      const sectionId = tidyState?.tabAssignments[t.id];
      const manualTitle = tidyState?.manualTitles?.[t.id];
      const tidiedTitle = tidyState?.tidiedTitles?.[t.id];
      const displayTitle = manualTitle ?? tidiedTitle ?? t.title;
      const searchTitles = [t.title.toLowerCase()];
      if (tidiedTitle) searchTitles.push(tidiedTitle.toLowerCase());
      if (manualTitle) searchTitles.push(manualTitle.toLowerCase());
      return {
        ...t,
        kind: "tab" as const,
        title: displayTitle,
        searchTitles,
        sectionName: sectionId ? sectionById.get(sectionId) : undefined,
      };
    });
  }, [tabs, allTabs, query, tidyState, sectionById]);

  const filteredTabs = useMemo(() => {
    if (isActionMode) return enrichedTabs;
    if (!query.trim()) return enrichedTabs;
    const q = query.trim();
    const scored = enrichedTabs
      .map((t) => {
        const titleScore = Math.max(...(t.searchTitles?.map((s) => fuzzyScore(q, s)) ?? [0]));
        const urlScore = fuzzyScore(q, t.url);
        return { tab: t, score: Math.max(titleScore, urlScore) };
      })
      .filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.tab);
  }, [enrichedTabs, query, isActionMode]);

  const closedFavorites = useMemo((): OverlayTab[] => {
    if (!activeSpace) return [];
    const assocUrls = new Set(favoriteAssociationsList.map((a) => a.favoriteUrl));
    return activeSpace.favorites
      .filter((f) => !assocUrls.has(f.url))
      .map((f) => ({
        id: -1,
        url: f.url,
        title: f.title,
        favicon: f.favicon,
        pinned: false,
        active: false,
        windowId: windowId ?? -1,
        kind: "favorite" as const,
      }));
  }, [activeSpace, favoriteAssociationsList, windowId]);

  const filteredRecentlyClosed = useMemo(() => {
    const liveUrls = new Set(enrichedTabs.map((t) => t.url));

    if (!query.trim()) {
      const deduped = recentlyClosed.filter((t) => !liveUrls.has(t.url) && !favoriteUrls.has(t.url));
      return deduped.sort((a, b) => frecencyScore(b) - frecencyScore(a));
    }

    const results = historySearchResults.filter(
      (t) => !liveUrls.has(t.url) && !favoriteUrls.has(t.url),
    );
    return results.sort((a, b) => frecencyScore(b) - frecencyScore(a));
  }, [recentlyClosed, historySearchResults, query, enrichedTabs, favoriteUrls]);

  const filteredBookmarks = useMemo(() => {
    if (!query.trim()) return [];
    const liveUrls = new Set(enrichedTabs.map((t) => t.url));
    const closedUrls = new Set(filteredRecentlyClosed.map((t) => t.url));
    const q = query.trim();
    return bookmarks
      .filter((b) => !liveUrls.has(b.url) && !favoriteUrls.has(b.url) && !closedUrls.has(b.url))
      .map((b) => ({ b, score: Math.max(fuzzyScore(q, b.title), fuzzyScore(q, b.url)) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => s.b);
  }, [bookmarks, query, enrichedTabs, filteredRecentlyClosed, favoriteUrls]);

  const orderedTabs = useMemo(() => {
    if (isActionMode) return filteredTabs;
    if (historyMode) return filteredRecentlyClosed;
    const q = query.toLowerCase();

    const favItems = closedFavorites.filter(
      (f) => !q || fuzzyScore(query.trim(), f.title) > 0 || fuzzyScore(query.trim(), f.url) > 0,
    );

    const pinned = filteredTabs.filter((t) => t.pinned);
    const openFavs = filteredTabs.filter((t) => !t.pinned && associatedTabIds.has(t.id));
    const active = filteredTabs.filter((t) => !t.pinned && !associatedTabIds.has(t.id));

    const sectionMap = new Map<string, OverlayTab[]>();
    const ungrouped: OverlayTab[] = [];
    for (const tab of active) {
      if (tab.sectionName) {
        const list = sectionMap.get(tab.sectionName) ?? [];
        list.push(tab);
        sectionMap.set(tab.sectionName, list);
      } else {
        ungrouped.push(tab);
      }
    }

    const result: OverlayTab[] = [...pinned, ...favItems, ...openFavs];
    for (const sectionTabs of sectionMap.values()) {
      result.push(...sectionTabs);
    }
    const closedToShow = query.trim() ? filteredRecentlyClosed : filteredRecentlyClosed.slice(0, 8);
    result.push(...ungrouped, ...filteredBookmarks, ...closedToShow);
    return result;
  }, [filteredTabs, closedFavorites, associatedTabIds, isActionMode, query, historyMode, filteredRecentlyClosed, filteredBookmarks]);

  const initialFocusSet = useRef(false);
  useEffect(() => {
    if (!initialFocusSet.current && orderedTabs.length > 0 && !query) {
      const activeIndex = orderedTabs.findIndex((t) => t.active);
      if (activeIndex >= 0) {
        setFocusIndex(activeIndex);
        initialFocusSet.current = true;
      }
    }
  }, [orderedTabs, query]);

  useEffect(() => {
    if (initialFocusSet.current) setFocusIndex(0);
  }, [query]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHistorySearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: "SEARCH_HISTORY", query: q, maxResults: 50 }).then((res) => {
        if (cancelled) return;
        if (res?.ok) {
          setHistorySearchResults(
            res.results.map((h: { url: string; title: string; favicon: string; lastVisitTime: number; visitCount: number }) => ({
              id: -1,
              url: h.url,
              title: h.title,
              favicon: h.favicon,
              pinned: false,
              active: false,
              windowId: windowId ?? -1,
              kind: "closed" as const,
              lastVisitTime: h.lastVisitTime,
              visitCount: h.visitCount,
            })),
          );
        }
      });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, windowId]);

  const handleFocusIndex = useCallback((i: number) => {
    if (actionsOpen) return;
    setFocusIndex(i);
  }, [actionsOpen]);

  const focusedTab = orderedTabs[focusIndex] ?? null;

  const generateTitleIfNeeded = useCallback(
    (target: OverlayTab) => {
      if (target.id < 0) return;
      const hasTitle = !!(tidyState?.manualTitles?.[target.id] || tidyState?.tidiedTitles?.[target.id]);
      if (hasTitle || generatingTitles.has(target.id)) return;
      setGeneratingTitles((prev) => new Set(prev).add(target.id));
      chrome.runtime.sendMessage({ type: "GENERATE_TAB_TITLE", tabId: target.id }).then((res) => {
        if (res?.ok && res.tidiedTitle) {
          setTidyState((prev) => {
            if (!prev) return { sections: [], tabAssignments: {}, tidiedTitles: { [target.id]: res.tidiedTitle }, manualTitles: {} };
            return { ...prev, tidiedTitles: { ...prev.tidiedTitles, [target.id]: res.tidiedTitle } };
          });
        }
        setGeneratingTitles((prev) => { const next = new Set(prev); next.delete(target.id); return next; });
      });
    },
    [tidyState, generatingTitles],
  );

  const execAction = useCallback(
    async (action: string, tab?: OverlayTab) => {
      const target = tab ?? focusedTab;
      if (!target) return;

      if (action === "copy") {
        await navigator.clipboard.writeText(target.url);
        showToast("URL copied");
        return;
      }

      if (action === "rename") {
        setRenamingTabId(target.id);
        return;
      }

      if (action.startsWith("move:")) {
        const targetSpaceId = action.slice(5);
        const targetSpace = spaces.find((s) => s.id === targetSpaceId);
        if (target.kind === "favorite") {
          const res = await chrome.runtime.sendMessage({
            type: "OVERLAY_MOVE_FAVORITE",
            url: target.url,
            targetSpaceId,
          });
          if (res?.ok) {
            showToast(`Moved to ${targetSpace?.name ?? "space"}`, res.undo ? { action: "move-favorite", ...res.undo } : undefined);
          }
        } else {
          const res = await chrome.runtime.sendMessage({
            type: "OVERLAY_MOVE_TAB",
            tabId: target.id,
            targetSpaceId,
          });
          if (favoriteUrls.has(target.url)) {
            await chrome.runtime.sendMessage({
              type: "OVERLAY_MOVE_FAVORITE",
              url: target.url,
              targetSpaceId,
            });
          }
          if (res?.ok && res.undo) {
            showToast(`Moved to ${targetSpace?.name ?? "space"}`, { action: "move", ...res.undo });
          }
        }
        fetchTabs();
        return;
      }

      if ((target.kind === "closed" || target.kind === "bookmark") && action === "open") {
        await chrome.runtime.sendMessage({
          type: "OVERLAY_OPEN_URL",
          url: target.url,
        });
        closeOverlay();
        return;
      }

      if (target.kind === "favorite" && action === "open") {
        await chrome.runtime.sendMessage({
          type: "OVERLAY_OPEN_URL",
          url: target.url,
          source: "favorite",
        });
        closeOverlay();
        return;
      }

      if (target.kind === "favorite" && action === "pin") {
        generateTitleIfNeeded(target);
        const res = await chrome.runtime.sendMessage({
          type: "OVERLAY_PIN_FAVORITE",
          url: target.url,
        });
        if (res?.ok) {
          showToast("Pinned", res.undo);
        }
        fetchTabs();
        return;
      }

      if (action === "favorite" || action === "pin") {
        generateTitleIfNeeded(target);
      }

      const res = await chrome.runtime.sendMessage({
        type: "OVERLAY_TAB_ACTION",
        action,
        tabId: target.id,
        url: target.url,
      });

      const toastMessages: Record<string, string> = {
        close: "Closed 1 tab",
        pin: "Pinned",
        unpin: "Unpinned → Favorites",
        favorite: "Favorited",
        unfavorite: "Unfavorited",
      };
      if (toastMessages[action]) {
        showToast(toastMessages[action], res?.undo);
      }

      if (action === "open") {
        closeOverlay();
      } else if (action === "close") {
        fetchTabs();
      } else {
        fetchTabs();
      }
    },
    [focusedTab, fetchTabs, generateTitleIfNeeded, spaces, favoriteUrls],
  );

  const execGlobalAction = useCallback(
    async (actionId: string) => {
      if (actionId === "chat") {
        await chrome.runtime.sendMessage({ type: "OPEN_SIDEPANEL_SEARCH" });
        closeOverlay();
        return;
      }
      if (actionId === "configure-space") {
        handleOpenConfigureSpace();
        return;
      }
      if (actionId === "new-space") {
        setCreatingSpace(true);
        setIsActionMode(false);
        setQuery("");
        setFocusIndex(0);
        return;
      }
      if (actionId === "history") {
        setHistoryMode(true);
        setIsActionMode(false);
        setQuery("");
        setFocusIndex(0);
        return;
      }
      const res = await chrome.runtime.sendMessage({
        type: "OVERLAY_GLOBAL_ACTION",
        action: actionId,
      });
      if (actionId === "clean" && res?.closedCount) {
        showToast(
          `Closed ${res.closedCount} tab${res.closedCount === 1 ? "" : "s"}`,
          res.undo,
        );
        closeOverlay();
        return;
      }
      if (actionId !== "tidy" && actionId !== "history") {
        closeOverlay();
      }
    },
    [],
  );

  const createSpaceAndOpen = useCallback(
    async (name: string, icon: string | null) => {
      await chrome.runtime.sendMessage({
        type: "OVERLAY_GLOBAL_ACTION",
        action: "new-space",
        spaceName: name,
        spaceIcon: icon,
      });
      closeOverlay();
    },
    [],
  );

  const submitRename = useCallback(
    async (newTitle: string) => {
      if (renamingTabId === null || !newTitle.trim()) {
        setRenamingTabId(null);
        return;
      }
      const tab = orderedTabs.find((t) => t.id === renamingTabId);
      if (tab && newTitle.trim() === tab.title) {
        setRenamingTabId(null);
        return;
      }
      await chrome.runtime.sendMessage({
        type: "OVERLAY_TAB_ACTION",
        action: "rename",
        tabId: renamingTabId,
        url: tab?.url ?? "",
        newTitle: newTitle.trim(),
      });
      setTidyState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          manualTitles: { ...prev.manualTitles, [renamingTabId]: newTitle.trim() },
        };
      });
      setRenamingTabId(null);
    },
    [renamingTabId, orderedTabs],
  );

  const handleRenameSection = useCallback(
    async (oldName: string, newName: string) => {
      await chrome.runtime.sendMessage({
        type: "OVERLAY_RENAME_SECTION",
        oldName,
        newName,
      });
      setTidyState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          sections: prev.sections.map((s) =>
            s.name === oldName ? { ...s, name: newName } : s,
          ),
        };
      });
    },
    [],
  );

  const handleArchiveSection = useCallback(
    async (sectionName: string) => {
      const sectionId = tidyState?.sections.find((s) => s.name === sectionName)?.id;
      if (!sectionId || !tidyState) return;
      const tabIds = Object.entries(tidyState.tabAssignments)
        .filter(([, id]) => id === sectionId)
        .map(([tabId]) => Number(tabId));
      if (tabIds.length === 0) return;
      const res = await chrome.runtime.sendMessage({
        type: "OVERLAY_ARCHIVE_SECTION",
        tabIds,
      });
      if (res?.ok) {
        showToast(`Closed ${tabIds.length} tab${tabIds.length === 1 ? "" : "s"}`, res.undo);
      }
      fetchTabs();
    },
    [tidyState, fetchTabs],
  );

  const handleReorder = useCallback(
    async (event: ReorderEvent) => {
      const { zone, tabId, overTabId, fromSection, toSection } = event;

      if (zone === "favorites") {
        const url = tabId as string;
        const overUrl = overTabId as string;

        // Optimistic reorder so dnd-kit doesn't snap back
        setSpaces((prev) =>
          prev.map((s) => {
            if (s.id !== activeSpaceId) return s;
            const favs = [...s.favorites];
            const fromIdx = favs.findIndex((f) => f.url === url);
            const toIdx = favs.findIndex((f) => f.url === overUrl);
            if (fromIdx === -1 || toIdx === -1) return s;
            const [moved] = favs.splice(fromIdx, 1);
            const insertIdx = favs.findIndex((f) => f.url === overUrl);
            favs.splice(insertIdx, 0, moved);
            favs.forEach((f, i) => { f.position = i; });
            return { ...s, favorites: favs };
          }),
        );

        await chrome.runtime.sendMessage({
          type: "OVERLAY_REORDER_FAVORITES",
          url,
          overUrl,
        });
        fetchTabs();
        return;
      }

      // zone is "pinned" or "active" — these are real tabs
      await chrome.runtime.sendMessage({
        type: "OVERLAY_REORDER_TABS",
        tabId: tabId as number,
        overTabId: overTabId as number,
        sectionChange: fromSection !== toSection ? toSection ?? null : null,
      });
      fetchTabs();
    },
    [fetchTabs, activeSpaceId],
  );

  const handleReorderSpaces = useCallback(
    async (updated: Space[]) => {
      setSpaces(updated);
      await storage.setSpaces(updated);
    },
    [],
  );

  const dismissAutoTidyNotification = useCallback(() => {
    setAutoTidyNotification(null);
    chrome.runtime.sendMessage({ type: "DISMISS_AUTO_TIDY_NOTIFICATION" });
  }, []);

  const handleOpenConfigureSpace = useCallback(() => {
    setConfiguringSpace(true);
    setIsActionMode(false);
    setQuery("");
    setFocusIndex(0);
  }, []);

  const handleUpdateSpaceName = useCallback(
    async (name: string) => {
      if (!activeSpaceId) return;
      await storage.updateSpace(activeSpaceId, { name });
      setSpaces((prev) => prev.map((s) => (s.id === activeSpaceId ? { ...s, name } : s)));
    },
    [activeSpaceId],
  );

  const handleUpdateSpaceIcon = useCallback(
    async (icon: string | null) => {
      if (!activeSpaceId) return;
      await storage.updateSpace(activeSpaceId, { icon });
      setSpaces((prev) => prev.map((s) => (s.id === activeSpaceId ? { ...s, icon } : s)));
    },
    [activeSpaceId],
  );

  const handleColorSaveAndExit = useCallback(
    async (colors: string[] | null, colorMode: "auto" | "light" | "dark" | null) => {
      if (!activeSpaceId) return;
      await storage.updateSpace(activeSpaceId, { colors, colorMode });
      setSpaces((prev) =>
        prev.map((s) =>
          s.id === activeSpaceId ? { ...s, colors, colorMode } : s,
        ),
      );
      setEditingColor(false);
      setPreviewColors(null);
      setPreviewColorMode(null);
    },
    [activeSpaceId],
  );

  const handleColorSave = useCallback(
    (colors: string[] | null, colorMode: "auto" | "light" | "dark" | null) => {
      handleColorSaveAndExit(colors, colorMode);
    },
    [handleColorSaveAndExit],
  );

  const handleColorPreview = useCallback(
    (colors: string[] | null, colorMode: "auto" | "light" | "dark" | null) => {
      setPreviewColors(colors);
      setPreviewColorMode(colorMode);
    },
    [],
  );

  const handleExitColorPicker = useCallback(() => {
    setEditingColor(false);
    setPreviewColors(null);
    setPreviewColorMode(null);
  }, []);

  const handleRemoveColor = useCallback(async () => {
    if (!activeSpaceId) return;
    await storage.updateSpace(activeSpaceId, { colors: null, colorMode: null });
    setSpaces((prev) =>
      prev.map((s) => (s.id === activeSpaceId ? { ...s, colors: null, colorMode: null } : s)),
    );
  }, [activeSpaceId]);

  const handleDeleteSpace = useCallback(async () => {
    if (!activeSpaceId) return;
    await chrome.runtime.sendMessage({ type: "DELETE_SPACE", spaceId: activeSpaceId });
    closeOverlay();
  }, [activeSpaceId]);

  const handleSwitchSpace = useCallback(
    (spaceId: string) => {
      chrome.runtime.sendMessage({ type: "SWITCH_SPACE", spaceId });
      closeOverlay();
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.code === "Comma") {
          e.preventDefault();
          chrome.tabs.create({ url: chrome.runtime.getURL("/settings.html") });
          closeOverlay();
          return;
        }
        const digitMatch = e.code.match(/^Digit([1-9])$/);
        if (digitMatch) {
          e.preventDefault();
          chrome.runtime.sendMessage({
            type: "SWITCH_SPACE_BY_POSITION",
            position: parseInt(digitMatch[1], 10),
          });
          closeOverlay();
          return;
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        window.parent.postMessage({ type: "OPENBROWSE_TRIGGER_UNDO" }, "*");
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (!isActionMode) {
          setActionsOpen((prev) => !prev);
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        if (renamingTabId !== null) {
          setRenamingTabId(null);
        } else if (actionsOpen) {
          setActionsOpen(false);
        } else if (editingColor) {
          handleExitColorPicker();
        } else if (configuringSpace) {
          setConfiguringSpace(false);
        } else if (creatingSpace) {
          setCreatingSpace(false);
          setIsActionMode(true);
          setQuery("");
          setFocusIndex(0);
        } else if (isActionMode) {
          setIsActionMode(false);
          setQuery("");
          setFocusIndex(0);
        } else if (historyMode && !query) {
          setHistoryMode(false);
          setFocusIndex(0);
        } else if (query) {
          setQuery("");
        } else {
          closeOverlay();
        }
        return;
      }

      if (e.key === "Backspace" && isActionMode && !query) {
        e.preventDefault();
        setIsActionMode(false);
        setFocusIndex(0);
        return;
      }

      if (creatingSpace && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        createSpaceSubmitRef.current?.();
        return;
      }

      if (creatingSpace || renamingTabId !== null) return;

      const listLength = isActionMode ? actionItems.length : orderedTabs.length;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((i) => Math.min(i + 1, listLength - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((i) => Math.max(i - 1, 0));
        return;
      }

      if (e.key === "Enter" && !actionsOpen) {
        e.preventDefault();
        if (isActionMode) {
          const item = actionItems[focusIndex];
          if (item) {
            if (item.type === "space") {
              handleSwitchSpace(item.id.replace("space-", ""));
            } else {
              execGlobalAction(item.id);
            }
          }
        } else {
          execAction("open");
        }
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [orderedTabs.length, actionItems, actionsOpen, query, execAction, execGlobalAction, handleSwitchSpace, isActionMode, creatingSpace, renamingTabId, focusIndex, historyMode, editingColor, configuringSpace, handleExitColorPicker]);

  const isFavorited = focusedTab ? favoriteUrls.has(focusedTab.url) : false;

  if (!ready) return null;

  return (
    <div
      className="flex flex-col rounded-xl shadow-lg overflow-clip"
      style={
        themedStyles
          ? {
              background: themedStyles.borderGradient,
              padding: "2.5px",
            }
          : undefined
      }
    >
      <div
        className={`flex flex-col rounded-xl overflow-clip ${!themedStyles ? "border border-border" : ""} bg-popover`}
      >
        <OverlayHeader
          activeSpace={activeSpace}
          spaces={spaces}
          query={query}
          onQueryChange={handleQueryChange}
          inputRef={inputRef}
          isActionMode={isActionMode}
          creatingSpace={creatingSpace}
          configuringSpace={configuringSpace}
          editingColor={editingColor}
          onSwitchSpace={handleSwitchSpace}
          historyMode={historyMode}
          onOpenChat={() => execGlobalAction("chat")}
          onExitHistory={() => {
            setHistoryMode(false);
            setQuery("");
            setFocusIndex(0);
          }}
          onBack={() => {
            if (editingColor) {
              handleExitColorPicker();
            } else if (configuringSpace) {
              setConfiguringSpace(false);
            } else {
              setCreatingSpace(false);
              setIsActionMode(true);
              setQuery("");
              setFocusIndex(0);
            }
          }}
          onConfigureSpace={handleOpenConfigureSpace}
        />
        {autoTidyNotification && !isActionMode && !creatingSpace && !configuringSpace && !editingColor && (
          <AutoTidyBanner
            notification={autoTidyNotification}
            onDismiss={dismissAutoTidyNotification}
          />
        )}
        {editingColor ? (
          <SpaceColorPicker
            initialColors={activeSpace?.colors ?? null}
            initialColorMode={activeSpace?.colorMode ?? null}
            systemDark={systemDark}
            onSave={handleColorSave}
            onPreview={handleColorPreview}
          />
        ) : configuringSpace ? (
          <ConfigureSpaceView
            name={activeSpace?.name ?? ""}
            icon={activeSpace?.icon ?? null}
            colors={activeSpace?.colors ?? null}
            openTabCount={activeSpaceTabCount}
            onUpdateName={handleUpdateSpaceName}
            onUpdateIcon={handleUpdateSpaceIcon}
            onEditColor={() => setEditingColor(true)}
            onRemoveColor={handleRemoveColor}
            onDeleteSpace={handleDeleteSpace}
          />
        ) : creatingSpace ? (
          <CreateSpaceForm onSubmit={createSpaceAndOpen} submitRef={createSpaceSubmitRef} />
        ) : isActionMode ? (
          <OverlayActionList
            actionQuery={query}
            spaces={spaces}
            activeSpaceId={activeSpaceId}
            focusIndex={focusIndex}
            isTidying={isTidying}
            tidyProgress={tidyProgress}
            onFocusIndex={setFocusIndex}
            onAction={execGlobalAction}
            onSwitchSpace={handleSwitchSpace}
            onReorderSpaces={handleReorderSpaces}
          />
        ) : (
          <OverlayTabList
            tabs={orderedTabs}
            focusIndex={focusIndex}
            onFocusIndex={handleFocusIndex}
            onOpen={(tab) => execAction("open", tab)}
            onAction={(action, tab) => execAction(action, tab)}
            onReorder={handleReorder}
            onRenameSection={handleRenameSection}
            onArchiveSection={handleArchiveSection}
            renamingTabId={renamingTabId}
            onStartRename={(tab) => setRenamingTabId(tab.id)}
            onSubmitRename={submitRename}
            onCancelRename={() => setRenamingTabId(null)}
            favoriteUrls={favoriteUrls}
            associatedTabIds={associatedTabIds}
            favoriteAssociations={favoriteAssociationsMap}
            isSearching={query.trim().length > 0}
            historyMode={historyMode}
            generatingTitles={generatingTitles}
          />
        )}
        {!configuringSpace && !editingColor && (
          <OverlayFooter
            actionsOpen={actionsOpen}
            onActionsOpenChange={setActionsOpen}
            actionsButtonRef={actionsButtonRef}
            focusedTab={focusedTab}
            isFavorited={isFavorited}
            isActionMode={isActionMode}
            creatingSpace={creatingSpace}
            tidyProgress={tidyProgress}
            otherSpaces={otherSpaces}
            onAction={execAction}
            onCreateSpace={() => createSpaceSubmitRef.current?.()}
            onClose={closeOverlay}
          />
        )}
      </div>
    </div>
  );
}
