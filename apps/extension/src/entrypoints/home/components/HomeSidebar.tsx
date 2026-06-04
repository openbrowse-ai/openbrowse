import { Logo } from "@/components/ui/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { chatDb } from "@/lib/chat-db";
import { openSettingsTab } from "@/lib/open-settings";
import type { Space } from "@/lib/types";
import {
  EllipsisVertical,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Settings,
  Trash2,
  Clock,
} from "lucide-react";
import { Popover } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveAgents } from "@/hooks/useActiveAgents";

interface HomeSidebarProps {
  spaces: Space[];
  activeSpaceId: string | null;
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onGoHome: () => void;
  onOpenOverlay: () => void;
  onNewSpace: () => void;
  onConfigureSpace: () => void;
  onRenameConversation: (conv: { id: string; title: string }) => void;
  onDeleteConversation: (conv: { id: string; title: string }) => void;
  onOpenScheduled: () => void;
  onScheduleConversation: (conv: { id: string; title: string }) => void;
  /** True when the Scheduled view is the active main pane. */
  scheduledActive?: boolean;
}

interface ConversationItem {
  id: string;
  title: string;
  updatedAt: number;
}

const SIDEBAR_WIDTH = 260;
const HOTZONE_WIDTH = 24;

function SpacePicker({
  spaces,
  activeSpaceId,
  activeSpace,
  onNewSpace,
  onConfigureSpace,
}: {
  spaces: Space[];
  activeSpaceId: string | null;
  activeSpace: Space | undefined;
  onNewSpace: () => void;
  onConfigureSpace: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = spaces
    .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.position - b.position);

  function selectSpace(spaceId: string) {
    chrome.runtime.sendMessage({ type: "SWITCH_SPACE", spaceId });
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlighted]) selectSpace(filtered[highlighted].id);
    }
  }

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlighted(0);
    } else {
      const idx = filtered.findIndex((s) => s.id === activeSpaceId);
      if (idx >= 0) setHighlighted(idx);
    }
  }, [open]);

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = listRef.current?.children[highlighted] as
        | HTMLElement
        | undefined;
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [highlighted]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 flex-1 min-w-0 rounded-md hover:bg-sidebar-accent px-1.5 py-0.5 transition-colors"
        >
          <span className="text-sm font-semibold truncate flex-1 text-left">
            {activeSpace?.icon && `${activeSpace.icon} `}
            {activeSpace?.name ?? "OpenBrowse"}
          </span>
          <svg
            className="size-3 text-muted-foreground shrink-0"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path
              d="M4.5 6.5l3.5 3.5 3.5-3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 w-52 rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 overflow-hidden animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onKeyDown={handleKeyDown}
        >
          <div className="p-1">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search spaces..."
              autoFocus
              className="w-full rounded-md border border-input/30 bg-input/30 px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/50"
            />
          </div>
          <div ref={listRef} className="max-h-48 overflow-y-auto p-1">
            {filtered.map((space, i) => (
              <button
                key={space.id}
                type="button"
                onClick={() => selectSpace(space.id)}
                onMouseEnter={() => setHighlighted(i)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                  i === highlighted ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span className="shrink-0 w-5 text-center">
                  {space.icon || space.name.charAt(0)}
                </span>
                <span className="truncate">{space.name}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground text-center">
                No spaces found
              </p>
            )}
          </div>
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => { setOpen(false); onConfigureSpace(); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Settings className="shrink-0 size-3.5 ml-0.5" />
              <span>Configure space</span>
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); onNewSpace(); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <span className="shrink-0 w-5 text-center">+</span>
              <span>New space</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function HomeSidebar({
  spaces,
  activeSpaceId,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onGoHome,
  onOpenOverlay,
  onNewSpace,
  onConfigureSpace,
  onRenameConversation,
  onDeleteConversation,
  onOpenScheduled,
  onScheduleConversation,
  scheduledActive,
}: HomeSidebarProps) {
  const [pinned, setPinned] = useState(() => {
    const stored = localStorage.getItem("openbrowse-sidebar-pinned");
    return stored !== null ? stored === "true" : true;
  });
  const [hovering, setHovering] = useState(false);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [generatingTitles, setGeneratingTitles] = useState<Set<string>>(new Set());
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const activeAgents = useActiveAgents();

  useEffect(() => {
    localStorage.setItem("openbrowse-sidebar-pinned", String(pinned));
  }, [pinned]);

  const refresh = useCallback(async () => {
    // Normal chats: space-scoped roots (subagent children excluded upstream).
    const roots = await chatDb.listRootConversations(activeSpaceId);
    // Scheduled-task runs are global (spaceId null) and have a
    // parentConversationId, so listRootConversations omits them. Fetch the
    // full list and surface the per-run conversations regardless of space.
    const all = await chatDb.listConversations();
    const scheduledRuns = all.filter(
      (c) => c.subagentSlug === "scheduled" && !!c.parentConversationId,
    );
    const seen = new Set(roots.map((c) => c.id));
    const merged = [...roots];
    for (const run of scheduledRuns) {
      if (!seen.has(run.id)) merged.push(run);
    }
    merged.sort((a, b) => b.createdAt - a.createdAt);
    setConversations(merged);
  }, [activeSpaceId]);

  useEffect(() => {
    refresh();
  }, [refresh, activeConversationId]);

  useEffect(() => {
    function onGenerating(e: Event) {
      const id = (e as CustomEvent).detail?.id;
      if (id) setGeneratingTitles((prev) => new Set(prev).add(id));
    }
    function onUpdated(e: Event) {
      const { id, title } = (e as CustomEvent).detail ?? {};
      if (id) {
        setGeneratingTitles((prev) => { const next = new Set(prev); next.delete(id); return next; });
        if (title) {
          setConversations((prev) => prev.map((c) => c.id === id ? { ...c, title } : c));
        }
      }
    }
    // Optimistic delete: remove the row from the list the instant the user
    // confirms, instead of waiting for the DB delete + CONVERSATION_DELETED
    // broadcast → refetch round-trip.
    function onDeleted(e: Event) {
      const id = (e as CustomEvent).detail?.id;
      if (id) {
        setConversations((prev) => prev.filter((c) => c.id !== id));
      }
    }
    // If the DB delete failed after the optimistic removal, re-sync from
    // the source of truth so the row reappears.
    function onDeleteFailed() {
      refresh();
    }
    window.addEventListener("chat-title-generating", onGenerating);
    window.addEventListener("chat-title-updated", onUpdated);
    window.addEventListener("chat-deleted", onDeleted);
    window.addEventListener("chat-deleted-failed", onDeleteFailed);
    return () => {
      window.removeEventListener("chat-title-generating", onGenerating);
      window.removeEventListener("chat-title-updated", onUpdated);
      window.removeEventListener("chat-deleted", onDeleted);
      window.removeEventListener("chat-deleted-failed", onDeleteFailed);
    };
  }, [refresh]);

  // Cross-window conversation lifecycle: refetch when another extension
  // context (popup, side panel, etc.) creates, updates, or deletes a
  // conversation. The broadcast is field-filtered at the source so this
  // doesn't fire on per-message `updatedAt` bumps.
  useEffect(() => {
    function onMessage(msg: unknown) {
      if (typeof msg !== "object" || msg === null) return;
      const t = (msg as { type?: unknown }).type;
      if (
        t === "CONVERSATION_CREATED" ||
        t === "CONVERSATION_UPDATED" ||
        t === "CONVERSATION_DELETED"
      ) {
        refresh();
      }
    }
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [refresh]);

  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyN") {
        e.preventDefault();
        onNewConversation();
      }
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "Comma") {
        e.preventDefault();
        openSettings();
      }
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyH") {
        e.preventDefault();
        setPinned((prev) => !prev);
      }
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const digitMatch = e.code.match(/^Digit([1-9])$/);
        if (digitMatch) {
          e.preventDefault();
          chrome.runtime.sendMessage({
            type: "SWITCH_SPACE_BY_POSITION",
            position: parseInt(digitMatch[1], 10),
          });
        }
      }
    }
    document.addEventListener("keydown", handleKeydown, true);
    return () => document.removeEventListener("keydown", handleKeydown, true);
  }, [onNewConversation]);

  function handleMouseEnter() {
    if (pinned) return;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    setHovering(true);
  }

  function handleMouseLeave() {
    if (pinned) return;
    leaveTimer.current = setTimeout(() => setHovering(false), 150);
  }

  function openSettings() {
    void openSettingsTab();
  }

  const activeSpace = spaces.find((s) => s.id === activeSpaceId);

  return (
    <>
      {/* Spacer for pinned mode */}
      {pinned && <div style={{ width: SIDEBAR_WIDTH, flexShrink: 0 }} />}

      {/* Hot zone for collapsed mode */}
      {!pinned && !hovering && (
        <div
          className="fixed left-0 top-0 bottom-0 z-40"
          style={{ width: HOTZONE_WIDTH }}
          onMouseEnter={handleMouseEnter}
        />
      )}

      {/* Backdrop for floating mode */}
      {!pinned && hovering && (
        <>
          {/* Buffer zone covering sidebar's left margin — keeps sidebar open */}
          <div
            className="fixed top-0 bottom-0 left-0 z-50"
            style={{ width: 8 }}
            onMouseEnter={handleMouseEnter}
          />
          <div className="fixed inset-0 z-40" onMouseEnter={handleMouseLeave} />
        </>
      )}

      {/* Sidebar */}
      <aside
        ref={sidebarRef}
        className={`fixed z-50 flex flex-col bg-sidebar text-sidebar-foreground transition-all duration-200 ease-out ${
          !pinned && !hovering ? "-translate-x-full" : "translate-x-0"
        } ${
          !pinned && hovering
            ? "shadow-xl rounded-lg border border-sidebar-border"
            : "border-r border-sidebar-border"
        }`}
        style={{
          width: SIDEBAR_WIDTH,
          top: !pinned && hovering ? 8 : 0,
          left: !pinned && hovering ? 8 : 0,
          bottom: !pinned && hovering ? 8 : 0,
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* Logo + Space switcher */}
        <div className="flex items-center gap-2 px-3 py-3 border-b border-sidebar-border">
          <button
            type="button"
            onClick={onGoHome}
            className="shrink-0 rounded-md p-0.5 hover:bg-sidebar-accent transition-colors"
            title="Go home"
          >
            <Logo className="size-5" />
          </button>
          <SpacePicker
            spaces={spaces}
            activeSpaceId={activeSpaceId}
            activeSpace={activeSpace}
            onNewSpace={onNewSpace}
            onConfigureSpace={onConfigureSpace}
          />
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-0.5 px-2 py-2">
          <button
            type="button"
            onClick={onNewConversation}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-sidebar-accent transition-colors"
          >
            <MessageSquarePlus className="size-3.5 shrink-0" />
            <span className="flex-1 text-left">New chat</span>
            <Kbd>⌥N</Kbd>
          </button>
          <button
            type="button"
            onClick={onOpenOverlay}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-sidebar-accent transition-colors"
          >
            <Search className="size-3.5 shrink-0" />
            <span className="flex-1 text-left">Search tabs</span>
            <Kbd>⌥K</Kbd>
          </button>
          <button
            type="button"
            onClick={onOpenScheduled}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
              scheduledActive
                ? "bg-sidebar-accent text-sidebar-foreground"
                : "hover:bg-sidebar-accent"
            }`}
          >
            <Clock className="size-3.5 shrink-0" />
            <span className="flex-1 text-left">Scheduled</span>
          </button>
        </div>

        {/* Chats */}
        <div className="flex-1 overflow-y-auto styled-scrollbar border-t border-sidebar-border">
          <div className="flex items-center px-3 pt-2 pb-1">
            <p className="text-[10px] font-medium text-muted-foreground flex-1">
              Chats
            </p>
          </div>
          {conversations.length === 0 && (
            <p className="px-3 py-4 text-center text-[10px] text-muted-foreground">
              No conversations yet
            </p>
          )}
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group relative flex w-full items-center px-3 py-1.5 hover:bg-sidebar-accent transition-colors cursor-pointer ${
                conv.id === activeConversationId ? "bg-sidebar-accent" : ""
              }`}
              onClick={() => onSelectConversation(conv.id)}
            >
              {activeAgents.has(conv.id) && (
                <span className="relative mr-2 flex size-2 shrink-0">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-blue-500" />
                </span>
              )}
              <span className={`flex-1 truncate text-xs pr-5 ${generatingTitles.has(conv.id) ? "shimmer-text" : ""}`}>{conv.title}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-2 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                  >
                    <EllipsisVertical className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" sideOffset={4}>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onScheduleConversation(conv);
                    }}
                  >
                    <Clock className="size-3.5" />
                    Schedule
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onRenameConversation(conv);
                    }}
                  >
                    <Pencil className="size-3.5" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteConversation(conv);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-1 px-2 py-2 border-t border-sidebar-border">
          <button
            type="button"
            onClick={openSettings}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors flex-1"
          >
            <Settings className="size-3.5" />
            <span className="flex-1 text-left">Settings</span>
            <Kbd>⌥,</Kbd>
          </button>
          <button
            type="button"
            onClick={() => setPinned(!pinned)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
            title={pinned ? "Collapse sidebar" : "Pin sidebar"}
          >
            {pinned ? (
              <PanelLeftClose className="size-3.5" />
            ) : (
              <PanelLeftOpen className="size-3.5" />
            )}
          </button>
        </div>
      </aside>

    </>
  );
}
