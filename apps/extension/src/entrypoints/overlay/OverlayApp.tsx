import { useTheme } from "@/hooks/useTheme";
import { adjustColorsForMode, buildGradientBorder } from "@/lib/color-utils";
import { openSettingsTab } from "@/lib/open-settings";
import { storage } from "@/lib/storage";
import type { AutoTidyNotification, FavoriteTabAssociation, Space, TidyState } from "@/lib/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFilteredActions } from "./components/actions";
import { AutoTidyBanner } from "./components/AutoTidyBanner";
import { ConfigureSpaceView } from "./components/ConfigureSpaceView";
import { CreateSpaceForm } from "./components/CreateSpaceForm";
import { MatchList } from "./components/match/MatchList";
import { OverlayFooter } from "./components/OverlayFooter";
import { OverlayHeader } from "./components/OverlayHeader";
import { OverlayResultList } from "./components/OverlayResultList";
import { OverlayTabList, type ReorderEvent } from "./components/OverlayTabList";
import { SpaceColorPicker } from "./components/SpaceColorPicker";
import { useTidyProgress } from "./hooks/useTidyProgress";
import { buildMatches, MAX_RESULTS, type Match } from "./search/matches";
import {
    buildArtifactMatches,
    buildChatMatches,
    buildSpaceMatches,
    commandToPaletteResult,
    flattenGroups,
    groupResults,
    parseScope,
    type ArtifactLite,
    type ChatLite,
    type PaletteGroup,
    type PaletteKind,
    type PaletteResult,
    type SpaceLite,
} from "./search/palette";
import { loadShortcuts, recordShortcutSelection } from "./search/shortcuts";

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
  sessionId?: string;
}

function closeOverlay() {
  window.parent.postMessage({ type: "OPENBROWSE_OVERLAY_CLOSE" }, "*");
}

function showToast(message: string, undoData?: any) {
  window.parent.postMessage({ type: "OPENBROWSE_TOAST", message, undoData }, "*");
}

/**
 * Convert a Match back into an OverlayTab-shaped object so the existing
 * execAction / footer code can keep operating on a single shape.
 */
function matchToOverlayTab(m: Match, windowId: number | null): OverlayTab {
  let kind: OverlayTab["kind"];
  switch (m.source) {
    case "tab":
    case "tab-other-space":
      kind = "tab";
      break;
    case "favorite-open":
    case "favorite-closed":
      kind = "favorite";
      break;
    case "bookmark":
      kind = "bookmark";
      break;
    case "history":
    case "closed":
      kind = "closed";
      break;
  }
  return {
    id: m.tabId ?? -1,
    url: m.url,
    title: m.title,
    favicon: m.favicon,
    pinned: m.pinned ?? false,
    active: m.active ?? false,
    windowId: m.windowId ?? windowId ?? -1,
    spaceName: m.spaceName,
    spaceIcon: m.spaceIcon,
    sectionName: m.sectionName,
    kind,
    lastVisitTime: m.lastVisitTime,
    visitCount: m.visitCount,
    sessionId: (m as Match & { sessionId?: string }).sessionId,
  };
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
  // Active group scope (null = all groups). `"command"` replaces the old
  // action-mode: commands are a first-class group reached via the `/` token,
  // header click, or Tab — not a separate mode.
  const [scope, setScope] = useState<PaletteKind | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<number | null>(null);
  const [generatingTitles, setGeneratingTitles] = useState<Set<number>>(new Set());
  const [actionsOpen, setActionsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const tidyProgress = useTidyProgress();
  const inputRef = useRef<HTMLInputElement>(null);
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
  // Universal search: chat + artifact metadata (fetched from the background on
  // open) and the group a user has expanded past its cap via "show more".
  const [chats, setChats] = useState<ChatLite[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactLite[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<PaletteKind>>(
    () => new Set(),
  );

  // Chats live in the extension's IndexedDB and artifacts in OPFS — both are
  // only reliably reachable from an extension context (the content-injected
  // overlay iframe may be storage-partitioned), so fetch via the background.
  // Each source fails independently: a rejected fetch just omits its group.
  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: "OVERLAY_LIST_CHATS" })
      .then((res) => {
        if (res?.ok && Array.isArray(res.chats)) setChats(res.chats);
      })
      .catch(() => {});
    chrome.runtime
      .sendMessage({ type: "OVERLAY_LIST_ARTIFACTS" })
      .then((res) => {
        if (res?.ok && Array.isArray(res.artifacts)) setArtifacts(res.artifacts);
      })
      .catch(() => {});
  }, []);

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
          (res.recentlyClosed ?? []).map((rc: { url: string; title: string; favicon: string; lastVisitTime: number; visitCount: number; sessionId?: string }) => ({
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
            sessionId: rc.sessionId,
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

  const handleQueryChange = useCallback(
    (value: string) => {
      // A leading scope token (chat: / art: / space: / "/") sets the group
      // scope and is stripped from the visible query. History mode reads the
      // query literally (no scoping).
      if (!historyMode) {
        const p = parseScope(value);
        if (p.scope) {
          setScope(p.scope);
          setQuery(p.rest);
          setFocusIndex(0);
          return;
        }
      }
      setQuery(value);
    },
    [historyMode],
  );

  const sectionById = useMemo(() => {
    const map = new Map<string, string>();
    if (tidyState) {
      for (const s of tidyState.sections) map.set(s.id, s.name);
    }
    return map;
  }, [tidyState]);

  const hasQuery = useMemo(() => query.trim().length > 0, [query]);

  const enrichedTabs = useMemo(() => {
    const baseTabs = hasQuery ? [...tabs, ...allTabs] : tabs;
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
  }, [tabs, allTabs, hasQuery, tidyState, sectionById]);

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

  // Load Shortcuts personalization data once (used inside buildMatches via cache).
  const [shortcutsLoaded, setShortcutsLoaded] = useState(false);
  useEffect(() => {
    loadShortcuts().then(() => setShortcutsLoaded(true));
  }, []);

  const isFlatMode = hasQuery || historyMode;

  /**
   * Unified ranked URL match list — shown whenever the user is searching (with
   * no scope) or in history mode. A scope narrows away the URL group entirely;
   * the empty state (no query, no scope) falls back to `OverlayTabList`.
   */
  const matches = useMemo<Match[]>(() => {
    if (scope || !isFlatMode) return [];
    // Reference shortcutsLoaded to recompute when personalization arrives.
    void shortcutsLoaded;

    // Split current-window tabs vs. cross-space tabs for the new pipeline.
    const currentTabs = enrichedTabs.filter((t) => !t.spaceName);
    const otherSpaceTabs = enrichedTabs.filter((t) => !!t.spaceName);

    const all = buildMatches({
      query: query.trim(),
      tabs: currentTabs,
      otherSpaceTabs,
      closedFavorites,
      bookmarks,
      recentlyClosed,
      history: historySearchResults,
      tidyState,
      sectionById,
      favoriteUrls,
      associatedTabIds,
      associations: favoriteAssociationsList,
    });
    return all.slice(0, MAX_RESULTS);
  }, [
    isFlatMode,
    scope,
    query,
    enrichedTabs,
    closedFavorites,
    bookmarks,
    recentlyClosed,
    historySearchResults,
    tidyState,
    sectionById,
    favoriteUrls,
    associatedTabIds,
    favoriteAssociationsList,
    shortcutsLoaded,
  ]);

  // Space metadata for the Spaces group.
  const spaceLites = useMemo<SpaceLite[]>(
    () =>
      spaces.map((s) => ({
        id: s.id,
        name: s.name,
        icon: s.icon,
        position: s.position,
      })),
    [spaces],
  );

  // Command results derived from the same action set as the old action-mode
  // (spaces excluded here — they have their own group). Filtered by the query.
  const commandItems = useFilteredActions(query.trim());

  // Entity/command groups. When a scope is active they are the whole view
  // (single group); in unscoped flat search they sit below the URL results.
  // History mode keeps its own dedicated list.
  const paletteExtras = useMemo<{ groups: PaletteGroup[]; flat: PaletteResult[] }>(() => {
    if (historyMode) return { groups: [], flat: [] };
    if (!scope && !isFlatMode) return { groups: [], flat: [] };
    const eq = query.trim();
    const commandResults = commandItems
      .filter((i) => i.type === "action")
      .map((i, idx) => commandToPaletteResult(i, idx));
    const groups = groupResults(
      {
        url: [],
        chat: buildChatMatches(eq, chats),
        artifact: buildArtifactMatches(eq, artifacts),
        space: buildSpaceMatches(eq, spaceLites),
        command: commandResults,
      },
      { scope, expanded: expandedGroups },
    );
    return { groups, flat: flattenGroups(groups) };
  }, [
    scope,
    isFlatMode,
    historyMode,
    query,
    commandItems,
    chats,
    artifacts,
    spaceLites,
    expandedGroups,
  ]);

  // Zero-state extras (no query): Recent chats, Recent artifacts, and a curated
  // command shortlist — rendered below the tab list for discoverability.
  const zeroExtras = useMemo<{ groups: PaletteGroup[]; flat: PaletteResult[] }>(() => {
    if (scope || isFlatMode) return { groups: [], flat: [] };
    const recentChats = buildChatMatches("", chats).slice(0, 3);
    const recentArtifacts = buildArtifactMatches("", artifacts).slice(0, 3);
    // Show the full command set in the zero state (same as the Commands scope),
    // in their declared order.
    const commands = commandItems
      .filter((i) => i.type === "action")
      .map((i, idx) => commandToPaletteResult(i, idx));
    const groups: PaletteGroup[] = [];
    if (recentChats.length)
      groups.push({ kind: "chat", label: "Recent chats", results: recentChats, total: recentChats.length, hasMore: false });
    if (recentArtifacts.length)
      groups.push({ kind: "artifact", label: "Recent artifacts", results: recentArtifacts, total: recentArtifacts.length, hasMore: false });
    if (commands.length)
      groups.push({ kind: "command", label: "Commands", results: commands, total: commands.length, hasMore: false });
    return { groups, flat: groups.flatMap((g) => g.results) };
  }, [scope, isFlatMode, chats, artifacts, commandItems]);

  /**
   * Legacy sectioned list — used only for the empty (no-query, no-history-mode)
   * default view. Includes pinned, favorites, tidy sections, ungrouped, and
   * recently-closed bottom block.
   */
  const orderedTabs = useMemo(() => {
    if (scope) return [];
    if (isFlatMode) {
      // When in flat mode, return matches converted to OverlayTab for footer/keyboard ops.
      return matches.map((m) => matchToOverlayTab(m, windowId));
    }

    const pinned = enrichedTabs.filter((t) => t.pinned);
    const openFavs = enrichedTabs.filter((t) => !t.pinned && associatedTabIds.has(t.id));
    const active = enrichedTabs.filter((t) => !t.pinned && !associatedTabIds.has(t.id));

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

    const result: OverlayTab[] = [...pinned, ...closedFavorites, ...openFavs];
    for (const sectionTabs of sectionMap.values()) {
      result.push(...sectionTabs);
    }
    // Recently-closed tabs are intentionally omitted from the empty-query
    // default view; they still surface when the user actually searches (via
    // the `closed` source in the URL match pipeline).
    result.push(...ungrouped);
    return result;
  }, [
    scope,
    isFlatMode,
    matches,
    windowId,
    enrichedTabs,
    associatedTabIds,
    closedFavorites,
  ]);

  // Unified focus model: the shared `focusIndex` spans the primary list
  // (URL matches in flat mode, tab list in zero state) followed by the extra
  // grouped results below it. When a scope is active there is no primary list.
  const showZeroExtras = !scope && !isFlatMode;
  const extraGroups = showZeroExtras ? zeroExtras.groups : paletteExtras.groups;
  const extrasFlat = showZeroExtras ? zeroExtras.flat : paletteExtras.flat;
  const primaryCount = orderedTabs.length;

  const initialFocusSet = useRef(false);
  useEffect(() => {
    if (!initialFocusSet.current && orderedTabs.length > 0 && !query && !historyMode) {
      const activeIndex = orderedTabs.findIndex((t) => t.active);
      if (activeIndex >= 0) {
        setFocusIndex(activeIndex);
        initialFocusSet.current = true;
      }
    }
  }, [orderedTabs, query, historyMode]);

  useEffect(() => {
    if (initialFocusSet.current) setFocusIndex(0);
  }, [query]);

  // Reset focus when entering/exiting flat-mode or changing scope.
  useEffect(() => {
    setFocusIndex(0);
  }, [isFlatMode, scope]);

  /**
   * Inline autocomplete: if the top match is a personalized Shortcut and its
   * title or compact URL has the current query as a case-insensitive prefix,
   * surface a ghost suffix in the input. Conservative — only on Shortcuts to
   * avoid suggestions feeling intrusive.
   */
  const inlineCompletion = useMemo(() => {
    const q = query.trim();
    if (!q || scope || !matches.length) return "";
    const top = matches[0];
    if (!top.isShortcut) return "";
    const candidates: string[] = [];
    if (top.title) candidates.push(top.title);
    try {
      const u = new URL(top.url);
      const compact = u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
      candidates.push(compact);
    } catch {
      candidates.push(top.url);
    }
    const qLower = q.toLowerCase();
    for (const c of candidates) {
      if (c.toLowerCase().startsWith(qLower) && c.length > q.length) {
        // Preserve original case from the candidate so the displayed text reads naturally.
        return c.slice(q.length);
      }
    }
    return "";
  }, [matches, query, scope]);

  useEffect(() => {
    const q = query.trim();
    // In history mode we want to fetch even with empty query (show recent history).
    if (!q && !historyMode) {
      setHistorySearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: "SEARCH_HISTORY", query: q, maxResults: 200 }).then((res) => {
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
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, windowId, historyMode]);

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
        // Record personalization signal: user picked this URL for this query.
        if (query.trim()) recordShortcutSelection(query, target.url, target.title);
        await chrome.runtime.sendMessage({
          type: "OVERLAY_OPEN_URL",
          url: target.url,
          sessionId: target.sessionId,
        });
        closeOverlay();
        return;
      }

      if (target.kind === "favorite" && action === "open") {
        if (query.trim()) recordShortcutSelection(query, target.url, target.title);
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

      // Personalization: record any "open"/"switch" selection from a search
      // query so future searches surface this URL faster.
      if (action === "open" && query.trim()) {
        recordShortcutSelection(query, target.url, target.title);
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
    [focusedTab, fetchTabs, generateTitleIfNeeded, spaces, favoriteUrls, query],
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
        setScope(null);
        setQuery("");
        setFocusIndex(0);
        return;
      }
      if (actionId === "history") {
        setHistoryMode(true);
        setScope(null);
        setQuery("");
        setFocusIndex(0);
        return;
      }
      const res = await chrome.runtime.sendMessage({
        type: "OVERLAY_GLOBAL_ACTION",
        action: actionId,
        // The overlay iframe's `sender.tab.windowId` isn't reliably populated in
        // the background, so pass our known window id explicitly. Actions like
        // `tidy`/`clean` require it and otherwise silently no-op.
        windowId: windowId ?? undefined,
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
    // NOTE: relies on `handleOpenConfigureSpace` being a stable callback (its
    // own deps are []); adding it to deps would cause a TDZ error since it's
    // declared further down. `windowId` is declared above, so it's safe in deps.
    [windowId],
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
      const { zone, tabId, overTabId, fromSection, toSection, activeTab, overTab } = event;

      if (zone === "favorites") {
        // The favorites section mixes closed favorites (saved URL only,
        // `kind === "favorite"`) and open favorites (live tabs adopted by a
        // favorite). Resolve each side to its underlying *favorite URL* so
        // we can reorder the persisted `favorites` array, and — for open
        // favorites — also physically move the live Chrome tab.
        const assocByTab = new Map(
          favoriteAssociationsList.map((a) => [a.tabId, a.favoriteUrl]),
        );
        const favoriteUrlOf = (t?: OverlayTab): string | undefined => {
          if (!t) return undefined;
          if (t.kind === "favorite") return t.url; // closed favorite
          return assocByTab.get(t.id) ?? t.url; // open favorite → its fav url
        };
        const url = favoriteUrlOf(activeTab) ?? (tabId as string);
        const overUrl = favoriteUrlOf(overTab) ?? (overTabId as string);

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
        // The background persists the new favorites order AND physically
        // arranges the live favorite tabs to match it (handling open/open,
        // open/closed, and closed/closed drags uniformly), so we don't need
        // to issue a separate tab move here.
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
    [fetchTabs, activeSpaceId, favoriteAssociationsList],
  );

  const dismissAutoTidyNotification = useCallback(() => {
    setAutoTidyNotification(null);
    chrome.runtime.sendMessage({ type: "DISMISS_AUTO_TIDY_NOTIFICATION" });
  }, []);

  const handleOpenConfigureSpace = useCallback(() => {
    setConfiguringSpace(true);
    setScope(null);
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

  // Dispatch Enter/click on a non-URL result to its typed action.
  const dispatchResultAction = useCallback(
    (result: PaletteResult) => {
      const action = result.action;
      switch (action.type) {
        case "openChat":
          chrome.runtime.sendMessage({
            type: "OVERLAY_OPEN_CHAT",
            conversationId: action.conversationId,
          });
          closeOverlay();
          break;
        case "openArtifact":
          chrome.runtime.sendMessage({
            type: "OVERLAY_OPEN_ARTIFACT",
            artifactId: action.artifactId,
          });
          closeOverlay();
          break;
        case "switchSpace":
          handleSwitchSpace(action.spaceId);
          break;
        case "command":
          execGlobalAction(action.commandId);
          break;
        case "url":
          break;
      }
    },
    [handleSwitchSpace, execGlobalAction],
  );

  const handleScope = useCallback((kind: PaletteKind) => {
    setScope(kind);
    setFocusIndex(0);
    inputRef.current?.focus();
  }, []);

  // Activate whatever is focused: extras (chat/artifact/space/command) route
  // through dispatchResultAction; the primary tab list opens the focused tab.
  // Shared by keyboard Enter and the footer's ⏎ button so they never diverge.
  const activateFocused = useCallback(() => {
    if (focusIndex >= primaryCount) {
      const result = extrasFlat[focusIndex - primaryCount];
      if (result) dispatchResultAction(result);
    } else {
      execAction("open");
    }
  }, [focusIndex, primaryCount, extrasFlat, dispatchResultAction, execAction]);

  const clearScope = useCallback(() => {
    setScope(null);
    setFocusIndex(0);
    inputRef.current?.focus();
  }, []);

  const handleExpandGroup = useCallback((kind: PaletteKind) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.add(kind);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.code === "Comma") {
          e.preventDefault();
          void openSettingsTab();
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
        setActionsOpen((prev) => !prev);
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
          setQuery("");
          setFocusIndex(0);
        } else if (scope) {
          setScope(null);
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

      if (e.key === "Backspace" && scope && !query) {
        e.preventDefault();
        setScope(null);
        setFocusIndex(0);
        return;
      }

      if (creatingSpace && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        createSpaceSubmitRef.current?.();
        return;
      }

      if (creatingSpace || renamingTabId !== null) return;

      const listLength = primaryCount + extrasFlat.length;

      // Tab scopes to the group of the currently focused extra result (S2).
      if (e.key === "Tab") {
        const localIdx = focusIndex - primaryCount;
        const focused = localIdx >= 0 ? extrasFlat[localIdx] : undefined;
        if (focused) {
          e.preventDefault();
          handleScope(focused.kind);
          return;
        }
      }

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
        activateFocused();
        return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [orderedTabs.length, actionsOpen, query, execAction, execGlobalAction, handleSwitchSpace, scope, creatingSpace, renamingTabId, focusIndex, historyMode, editingColor, configuringSpace, handleExitColorPicker, primaryCount, extrasFlat, dispatchResultAction, handleScope, activateFocused]);

  const isFavorited = focusedTab ? favoriteUrls.has(focusedTab.url) : false;

  // Footer state: what Enter does + whether the tab ActionsPopover applies.
  const focusedResult =
    focusIndex >= primaryCount ? extrasFlat[focusIndex - primaryCount] ?? null : null;
  const enterLabel = focusedResult
    ? focusedResult.kind === "chat"
      ? "Open chat"
      : focusedResult.kind === "artifact"
        ? "Open artifact"
        : focusedResult.kind === "space"
          ? "Switch space"
          : "Run command"
    : "Open tab";
  const showTabActions = !scope && !focusedResult && !!focusedTab;

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
          scope={scope}
          creatingSpace={creatingSpace}
          configuringSpace={configuringSpace}
          editingColor={editingColor}
          onSwitchSpace={handleSwitchSpace}
          historyMode={historyMode}
          onOpenChat={() => execGlobalAction("chat")}
          inlineCompletion={inlineCompletion}
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
              setQuery("");
              setFocusIndex(0);
            }
          }}
          onConfigureSpace={handleOpenConfigureSpace}
        />
        {autoTidyNotification && !scope && !creatingSpace && !configuringSpace && !editingColor && (
          <AutoTidyBanner
            notification={autoTidyNotification}
            onDismiss={dismissAutoTidyNotification}
          />
        )}
        {scope && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Filtering</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
              {scope === "artifact"
                ? "Artifacts"
                : scope === "chat"
                  ? "Chats"
                  : scope === "space"
                    ? "Spaces"
                    : "Commands"}
            </span>
            <button
              type="button"
              onClick={clearScope}
              className="ml-auto flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear filter"
            >
              ✕
            </button>
          </div>
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
        ) : scope ? (
          <div className="max-h-80 overflow-y-auto overflow-x-hidden">
            <OverlayResultList
              groups={paletteExtras.groups}
              focusOffset={0}
              focusIndex={focusIndex}
              onFocusIndex={handleFocusIndex}
              onActivate={dispatchResultAction}
              onScope={handleScope}
              onExpand={handleExpandGroup}
            />
            {paletteExtras.groups.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matching results.
              </div>
            )}
          </div>
        ) : isFlatMode ? (
          <>
            {(matches.length > 0 || extrasFlat.length === 0) && (
              <MatchList
                matches={matches}
                focusIndex={focusIndex}
                onFocusIndex={handleFocusIndex}
                onAccept={(m) => execAction("open", matchToOverlayTab(m, windowId))}
                onClose={(m) => execAction("close", matchToOverlayTab(m, windowId))}
                onTogglePin={(m) =>
                  execAction(m.pinned ? "unpin" : "pin", matchToOverlayTab(m, windowId))
                }
                onToggleFavorite={(m) => {
                  const isFav =
                    m.source === "favorite-open" ||
                    m.source === "favorite-closed" ||
                    favoriteUrls.has(m.url);
                  execAction(isFav ? "unfavorite" : "favorite", matchToOverlayTab(m, windowId));
                }}
                emptyMessage={
                  historyMode && !query.trim() ? "No history yet." : "No matching results."
                }
              />
            )}
            {!historyMode && extraGroups.length > 0 && (
              <div className="max-h-72 overflow-y-auto overflow-x-hidden">
                <OverlayResultList
                  groups={extraGroups}
                  focusOffset={matches.length}
                  focusIndex={focusIndex}
                  onFocusIndex={handleFocusIndex}
                  onActivate={dispatchResultAction}
                  onScope={handleScope}
                  onExpand={handleExpandGroup}
                  topDivider={matches.length > 0}
                />
              </div>
            )}
          </>
        ) : (
          <>
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
              isSearching={false}
              historyMode={false}
              generatingTitles={generatingTitles}
            />
            {zeroExtras.groups.length > 0 && (
              <div className="max-h-60 overflow-y-auto overflow-x-hidden border-t border-border">
                <OverlayResultList
                  groups={zeroExtras.groups}
                  focusOffset={orderedTabs.length}
                  focusIndex={focusIndex}
                  onFocusIndex={handleFocusIndex}
                  onActivate={dispatchResultAction}
                />
              </div>
            )}
          </>
        )}
        {!configuringSpace && !editingColor && (
          <OverlayFooter
            actionsOpen={actionsOpen}
            onActionsOpenChange={setActionsOpen}
            focusedTab={focusedTab}
            isFavorited={isFavorited}
            showTabActions={showTabActions}
            enterLabel={enterLabel}
            creatingSpace={creatingSpace}
            tidyProgress={tidyProgress}
            otherSpaces={otherSpaces}
            onAction={execAction}
            onEnter={activateFocused}
            onCreateSpace={() => createSpaceSubmitRef.current?.()}
            onClose={closeOverlay}
          />
        )}
      </div>
    </div>
  );
}
