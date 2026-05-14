import type { FavoriteTabAssociation } from "@/lib/types";
import type { OverlayTab } from "../OverlayApp";
import { Kbd } from "@/components/ui/kbd";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, ArrowLeft, Bookmark, ChevronDown, ChevronRight, Clock, GripVertical, Heart, Pencil, Pin, RotateCcw, X } from "lucide-react";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
import { useEffect, useRef, useState } from "react";

export type DragZone = "pinned" | "favorites" | "active" | "closed" | "bookmark";

export interface ReorderEvent {
  zone: DragZone;
  tabId: number | string;
  overTabId: number | string;
  fromSection?: string;
  toSection?: string;
}

interface OverlayTabListProps {
  tabs: OverlayTab[];
  focusIndex: number;
  onFocusIndex: (i: number) => void;
  onOpen: (tab: OverlayTab) => void;
  onAction: (action: string, tab: OverlayTab) => void;
  onReorder?: (event: ReorderEvent) => void;
  onRenameSection?: (oldName: string, newName: string) => void;
  onArchiveSection?: (sectionName: string) => void;
  renamingTabId: number | null;
  onStartRename: (tab: OverlayTab) => void;
  onSubmitRename: (newTitle: string) => void;
  onCancelRename: () => void;
  favoriteUrls: Set<string>;
  associatedTabIds: Set<number>;
  favoriteAssociations: Map<string, FavoriteTabAssociation>;
  isSearching: boolean;
  historyMode?: boolean;
  generatingTitles?: Set<number>;
}

function faviconUrl(pageUrl: string, favicon: string): string {
  if (favicon) return favicon;
  try {
    const hostname = new URL(pageUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return "";
  }
}

type Section = {
  label: string | null;
  icon?: "pin" | "heart" | "clock" | "bookmark";
  zone: DragZone;
  tabs: OverlayTab[];
  collapsible?: boolean;
};

function buildSections(
  tabs: OverlayTab[],
  favoriteUrls: Set<string>,
  associatedTabIds: Set<number>,
  historyMode?: boolean,
  isSearching?: boolean,
): Section[] {
  const sections: Section[] = [];

  const localTabs = isSearching ? tabs.filter((t) => !t.spaceName) : tabs;
  const otherSpaceTabs = isSearching ? tabs.filter((t) => t.spaceName && t.kind !== "closed") : [];

  const pinned = localTabs.filter((t) => t.pinned);
  const favs = localTabs.filter((t) => !t.pinned && t.kind !== "closed" && t.kind !== "bookmark" && (t.kind === "favorite" || associatedTabIds.has(t.id)));
  const active = localTabs.filter((t) => !t.pinned && t.kind !== "favorite" && t.kind !== "closed" && t.kind !== "bookmark" && !associatedTabIds.has(t.id));

  if (pinned.length) sections.push({ label: "Pinned", icon: "pin", zone: "pinned", tabs: pinned });
  if (favs.length) sections.push({ label: "Favorites", icon: "heart", zone: "favorites", tabs: favs });

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
  for (const [name, sectionTabs] of sectionMap) {
    sections.push({ label: name, zone: "active", tabs: sectionTabs });
  }
  if (ungrouped.length) {
    const needsLabel = sectionMap.size > 0 || pinned.length > 0 || favs.length > 0;
    sections.push({
      label: needsLabel ? (sectionMap.size > 0 ? "Other" : "Tabs") : null,
      zone: "active",
      tabs: ungrouped,
    });
  } else if (!isSearching && active.length === 0 && (pinned.length > 0 || favs.length > 0)) {
    sections.push({ label: "Tabs", zone: "active", tabs: [] });
  }

  if (otherSpaceTabs.length) {
    sections.push({ label: "In other spaces", zone: "active", tabs: otherSpaceTabs });
  }

  const bookmarkTabs = localTabs.filter((t) => t.kind === "bookmark");
  if (bookmarkTabs.length) {
    sections.push({ label: "Bookmarks", icon: "bookmark", zone: "bookmark", tabs: bookmarkTabs });
  }

  const closed = localTabs.filter((t) => t.kind === "closed");
  if (closed.length) {
    if (historyMode) {
      sections.push({ label: null, zone: "closed", tabs: closed });
    } else {
      sections.push({ label: "Recently Closed", icon: "clock", zone: "closed", tabs: closed, collapsible: true });
    }
  }

  return sections;
}

const FIXED_LABELS = new Set(["Pinned", "Favorites", "Tabs", "Other", "In other spaces", "Recently Closed", "Bookmarks"]);

function SectionHeader({
  section,
  onRenameSection,
  onArchiveSection,
  collapsed,
  onToggleCollapse,
}: {
  section: Section;
  onRenameSection?: (oldName: string, newName: string) => void;
  onArchiveSection?: (sectionName: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(section.label ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const isRenameable = !!section.label && !FIXED_LABELS.has(section.label) && !!onRenameSection;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!section.label) return null;

  if (editing) {
    const submit = () => {
      const trimmed = value.trim();
      if (trimmed && trimmed !== section.label) {
        onRenameSection!(section.label!, trimmed);
      }
      setEditing(false);
    };
    return (
      <div className="flex items-center gap-1.5 px-3 py-1">
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-xs font-medium text-foreground outline-none border-b border-border"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") submit();
            if (e.key === "Escape") { setEditing(false); setValue(section.label ?? ""); }
          }}
          onBlur={submit}
        />
      </div>
    );
  }

  const Wrapper = section.collapsible ? "button" : "div";
  return (
    <Wrapper
      className={`group/section sticky top-0 z-10 flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-muted-foreground bg-popover w-full text-left ${section.collapsible ? "hover:text-foreground transition-colors cursor-pointer" : ""}`}
      onClick={section.collapsible ? onToggleCollapse : undefined}
    >
      {section.icon === "pin" && <Pin className="size-3" />}
      {section.icon === "heart" && <Heart className="size-3" />}
      {section.icon === "clock" && <Clock className="size-3" />}
      {section.icon === "bookmark" && <Bookmark className="size-3" />}
      {section.label}
      {section.collapsible && (
        <span className="ml-auto">
          {collapsed
            ? <ChevronRight className="size-3" />
            : <ChevronDown className="size-3" />}
        </span>
      )}
      {isRenameable && (
        <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/section:opacity-100 transition-opacity">
          <button
            className="size-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); setValue(section.label!); setEditing(true); }}
          >
            <Pencil className="size-2.5" />
          </button>
          {onArchiveSection && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="size-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                  onClick={(e) => { e.stopPropagation(); onArchiveSection(section.label!); }}
                >
                  <Archive className="size-2.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Close all tabs in section</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </Wrapper>
  );
}

function sortableId(tab: OverlayTab): string {
  if (tab.kind === "favorite") return `fav:${tab.url}`;
  if (tab.kind === "bookmark") return `bm:${tab.url}`;
  return `tab:${tab.id}`;
}

function SortableTabRow({
  tab,
  isFocused,
  idx,
  isRenaming,
  onFocusIndex,
  onOpen,
  onAction,
  onSubmitRename,
  onCancelRename,
  favoriteUrls,
  association,
  generatingTitles,
  isDragActive,
}: {
  tab: OverlayTab;
  isFocused: boolean;
  idx: number;
  isRenaming: boolean;
  onFocusIndex: (i: number) => void;
  onOpen: (tab: OverlayTab) => void;
  onAction: (action: string, tab: OverlayTab) => void;
  onSubmitRename: (newTitle: string) => void;
  onCancelRename: () => void;
  favoriteUrls: Set<string>;
  association?: FavoriteTabAssociation;
  generatingTitles?: Set<number>;
  isDragActive: boolean;
}) {
  const hasNavigatedAway = !!(association && association.currentUrl !== association.favoriteUrl);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId(tab) });

  const [renameValue, setRenameValue] = useState(tab.title);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(tab.title);
      setTimeout(() => {
        renameRef.current?.focus();
        renameRef.current?.select();
      }, 0);
    }
  }, [isRenaming, tab.title]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-tab-index={idx}
      className={`group flex w-full items-center gap-1 px-1 py-1.5 text-left text-sm transition-colors ${
        isFocused && !isDragActive
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-muted"
      } ${isDragging ? "z-50 relative" : ""}`}
      onClick={() => { if (!isRenaming) onFocusIndex(idx); }}
      onDoubleClick={() => { if (!isRenaming) onOpen(tab); }}
    >
      {tab.kind !== "closed" && tab.kind !== "bookmark" ? (
        <span
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="flex size-5 shrink-0 cursor-grab items-center justify-center rounded-sm text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity hover:text-muted-foreground active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-3" />
        </span>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      {hasNavigatedAway ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="size-4 shrink-0 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
              onClick={(e) => { e.stopPropagation(); chrome.tabs.update(association!.tabId, { url: association!.favoriteUrl }); }}
            >
              <ArrowLeft className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Back to {(() => { try { return new URL(association!.favoriteUrl).hostname; } catch { return association!.favoriteUrl; } })()}</TooltipContent>
        </Tooltip>
      ) : (
        <img
          src={faviconUrl(tab.url, tab.favicon)}
          alt=""
          className="size-4 shrink-0 rounded-sm"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      {hasNavigatedAway && (
        <span className="text-muted-foreground text-xs shrink-0">/</span>
      )}
      {isRenaming ? (
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); onSubmitRename(renameValue); }
            if (e.key === "Escape") { e.preventDefault(); onCancelRename(); }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 bg-transparent text-sm outline-none border-b border-border"
        />
      ) : (
        <span className="flex-1 truncate">
          {generatingTitles?.has(tab.id) ? (
            <Shimmer as="span" className="text-sm" duration={1.5}>{tab.title}</Shimmer>
          ) : (
            tab.title
          )}
        </span>
      )}
      {tab.spaceName && (
        <span className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground bg-muted">
          {tab.spaceIcon && <span>{tab.spaceIcon}</span>}
          {tab.spaceName}
        </span>
      )}
      {!isRenaming && tab.kind === "closed" && tab.lastVisitTime && (
        <span className="shrink-0 text-xs text-muted-foreground/60 group-hover:hidden">{formatRelativeTime(tab.lastVisitTime)}</span>
      )}
      {!isRenaming && (
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {(tab.kind === "closed" || tab.kind === "bookmark") ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
                  onClick={(e) => { e.stopPropagation(); onAction("open", tab); }}
                >
                  <RotateCcw className="size-3" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{tab.kind === "bookmark" ? "Open bookmark" : "Restore tab"}</TooltipContent>
            </Tooltip>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="button"
                    className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
                    onClick={(e) => { e.stopPropagation(); onAction(tab.pinned ? "unpin" : "pin", tab); }}
                  >
                    <Pin className="size-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{tab.pinned ? "Unpin" : "Pin"}</TooltipContent>
              </Tooltip>
              {!tab.pinned && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted"
                      onClick={(e) => { e.stopPropagation(); onAction(favoriteUrls.has(tab.url) || tab.kind === "favorite" ? "unfavorite" : "favorite", tab); }}
                    >
                      <Heart className={`size-3 ${favoriteUrls.has(tab.url) || tab.kind === "favorite" ? "fill-current" : ""}`} />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{favoriteUrls.has(tab.url) || tab.kind === "favorite" ? "Unfavorite" : "Favorite"}</TooltipContent>
                </Tooltip>
              )}
              {tab.kind !== "favorite" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-destructive hover:bg-muted"
                      onClick={(e) => { e.stopPropagation(); onAction("close", tab); }}
                    >
                      <X className="size-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">Close tab <Kbd>⌘W</Kbd></TooltipContent>
                </Tooltip>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function OverlayTabList({
  tabs,
  focusIndex,
  onFocusIndex,
  onOpen,
  onAction,
  onReorder,
  onRenameSection,
  onArchiveSection,
  renamingTabId,
  onStartRename,
  onSubmitRename,
  onCancelRename,
  favoriteUrls,
  associatedTabIds,
  favoriteAssociations,
  isSearching,
  historyMode,
  generatingTitles,
}: OverlayTabListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [userToggledClosed, setUserToggledClosed] = useState<boolean | null>(null);

  const activeTabs = tabs.filter((t) => t.kind !== "closed");
  const shouldAutoCollapse = !isSearching || activeTabs.length >= 10;

  const recentlyClosedCollapsed = userToggledClosed ?? shouldAutoCollapse;
  const collapsedSections = new Set(recentlyClosedCollapsed ? ["Recently Closed"] : []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const initialScrollDone = useRef(false);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-tab-index="${focusIndex}"]`) as HTMLElement | undefined;
    if (!el) return;
    if (!initialScrollDone.current) {
      el.scrollIntoView({ block: "center" });
      initialScrollDone.current = true;
    } else {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusIndex]);

  if (tabs.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        {isSearching ? "No matching tabs." : "No tabs in this space."}
      </div>
    );
  }

  const sections = buildSections(tabs, favoriteUrls, associatedTabIds, historyMode, isSearching);
  const canDrag = !isSearching && !!onReorder;

  const tabToZone = new Map<string, DragZone>();
  const tabToSection = new Map<string, string | undefined>();
  for (const section of sections) {
    for (const tab of section.tabs) {
      const id = sortableId(tab);
      tabToZone.set(id, section.zone);
      tabToSection.set(id, section.label ?? undefined);
    }
  }

  // Collect all "active" zone sortable IDs into one shared context
  const activeZoneIds: string[] = [];
  const pinnedZoneIds: string[] = [];
  const favoritesZoneIds: string[] = [];
  for (const section of sections) {
    for (const tab of section.tabs) {
      const id = sortableId(tab);
      if (section.zone === "pinned") pinnedZoneIds.push(id);
      else if (section.zone === "favorites") favoritesZoneIds.push(id);
      else activeZoneIds.push(id);
    }
  }

  function handleDragStart(_event: DragStartEvent) {
    setIsDragActive(true);
  }

  function handleDragEnd(event: DragEndEvent) {
    setIsDragActive(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const activeZone = tabToZone.get(activeId);
    const overZone = tabToZone.get(overId);

    if (!activeZone || !overZone) return;

    // Only allow reordering within the same zone
    if (activeZone !== overZone) return;

    const parseId = (sid: string) => {
      if (sid.startsWith("fav:")) return sid.slice(4);
      return parseInt(sid.slice(4), 10);
    };

    onReorder?.({
      zone: activeZone,
      tabId: parseId(activeId),
      overTabId: parseId(overId),
      fromSection: tabToSection.get(activeId),
      toSection: tabToSection.get(overId),
    });
  }

  let globalIndex = 0;

  const renderSection = (section: Section, gi: number) => {
    const isCollapsed = section.collapsible && section.label ? collapsedSections.has(section.label) : false;
    return (
      <div key={gi}>
        <SectionHeader
          section={section}
          onRenameSection={onRenameSection}
          onArchiveSection={onArchiveSection}
          collapsed={isCollapsed}
          onToggleCollapse={section.collapsible && section.label ? () => {
            if (section.label === "Recently Closed") {
              setUserToggledClosed((prev) => prev === null ? !shouldAutoCollapse : !prev);
            }
          } : undefined}
        />
        {!isCollapsed && section.tabs.length === 0 && (
          <div className="px-3 py-3 text-center text-xs text-muted-foreground">
            No active tabs
          </div>
        )}
        {!isCollapsed && section.tabs.map((tab) => {
          const idx = globalIndex++;
          return (
            <SortableTabRow
              key={sortableId(tab)}
              tab={tab}
              isFocused={idx === focusIndex}
              idx={idx}
              isRenaming={renamingTabId === tab.id && tab.id !== -1}
              onFocusIndex={onFocusIndex}
              onOpen={onOpen}
              onAction={onAction}
              onSubmitRename={onSubmitRename}
              onCancelRename={onCancelRename}
              favoriteUrls={favoriteUrls}
              association={favoriteAssociations.get(tab.url) ?? (tab.kind === "favorite" ? undefined : [...favoriteAssociations.values()].find((a) => a.tabId === tab.id))}
              generatingTitles={generatingTitles}
              isDragActive={isDragActive}
            />
          );
        })}
      </div>
    );
  };

  if (!canDrag) {
    return (
      <div ref={listRef} className="max-h-72 overflow-y-auto overflow-x-hidden py-1">
        {sections.map((section, gi) => renderSection(section, gi))}
      </div>
    );
  }

  // Render with 3 separate DndContexts per zone so drops are constrained
  const pinnedSections = sections.filter((s) => s.zone === "pinned");
  const favoriteSections = sections.filter((s) => s.zone === "favorites");
  const activeSections = sections.filter((s) => s.zone === "active");
  const closedSections = sections.filter((s) => s.zone === "closed");
  const bookmarkSections = sections.filter((s) => s.zone === "bookmark");

  return (
    <div ref={listRef} className="max-h-72 overflow-y-auto overflow-x-hidden py-1">
      {pinnedSections.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={pinnedZoneIds} strategy={verticalListSortingStrategy}>
            {pinnedSections.map((s, i) => renderSection(s, i))}
          </SortableContext>
        </DndContext>
      )}
      {favoriteSections.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={favoritesZoneIds} strategy={verticalListSortingStrategy}>
            {favoriteSections.map((s, i) => renderSection(s, pinnedSections.length + i))}
          </SortableContext>
        </DndContext>
      )}
      {activeSections.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={activeZoneIds} strategy={verticalListSortingStrategy}>
            {activeSections.map((s, i) => renderSection(s, pinnedSections.length + favoriteSections.length + i))}
          </SortableContext>
        </DndContext>
      )}
      {closedSections.length > 0 && (
        <>
          {closedSections.map((s, i) => renderSection(s, pinnedSections.length + favoriteSections.length + activeSections.length + i))}
        </>
      )}
      {bookmarkSections.length > 0 && (
        <>
          {bookmarkSections.map((s, i) => renderSection(s, pinnedSections.length + favoriteSections.length + activeSections.length + closedSections.length + i))}
        </>
      )}
    </div>
  );
}
