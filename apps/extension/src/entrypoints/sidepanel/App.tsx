import { formatMessageAsMarkdown } from "@/lib/format-markdown";
import { openSettingsTab } from "@/lib/open-settings";
import { chatDb } from "@/lib/chat-db";
import { storage } from "@/lib/storage";
import type { Space } from "@/lib/types";
import { useTheme } from "@/hooks/useTheme";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatView } from "@/components/chat/ChatView";
import { ChatPicker } from "@/components/chat/ChatPicker";
import { SpaceSwitcher } from "./components/SpaceSwitcher";
import { Download, ExternalLink, MessageSquarePlus, MoreVertical, Settings, PictureInPicture, PanelRight } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";

function readPopupParams() {
  if (typeof window === "undefined") {
    return {
      isPopupMode: false,
      isGlobalChat: false,
      originWindowId: null,
      originTabId: null,
      originUrl: null,
      initialConversationId: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const isPopupMode = params.get("mode") === "popup";
  const isGlobalChat = params.get("globalChat") === "true";
  const owid = params.get("originWindowId");
  const otid = params.get("originTabId");
  const ourl = params.get("originUrl");
  const cid = params.get("conversationId");
  return {
    isPopupMode,
    isGlobalChat,
    originWindowId: owid ? Number(owid) : null,
    originTabId: otid ? Number(otid) : null,
    originUrl: ourl && ourl.length > 0 ? ourl : null,
    initialConversationId: cid && cid.length > 0 ? cid : null,
  };
}

export default function App() {
  useTheme();
  const { isPopupMode, isGlobalChat, originWindowId, originTabId, originUrl, initialConversationId } = readPopupParams();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(initialConversationId);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const [generatingTitleIds, setGeneratingTitleIds] = useState<Set<string>>(new Set());
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  useEffect(() => {
    async function init() {
      const allSpaces = await storage.getSpaces();
      setSpaces(allSpaces);

      // In popup mode, the popup's own window isn't a real space.
      // Resolve the active space from the origin window if known, otherwise
      // fall back to the first space.
      if (isPopupMode) {
        if (originWindowId != null) {
          const space = await storage.getSpaceByWindowId(originWindowId);
          if (space) {
            setActiveSpaceId(space.id);
            return;
          }
        }
        if (allSpaces.length > 0) setActiveSpaceId(allSpaces[0].id);
        return;
      }

      const currentWindow = await chrome.windows.getCurrent();
      if (currentWindow.id) {
        const response = await chrome.runtime.sendMessage({
          type: "GET_OR_CREATE_SPACE",
          windowId: currentWindow.id,
        });
        if (response?.ok) {
          setActiveSpaceId(response.spaceId);
          const refreshed = await storage.getSpaces();
          setSpaces(refreshed);
        } else if (allSpaces.length > 0) {
          setActiveSpaceId(allSpaces[0].id);
        }

        try {
          const owned = await chrome.runtime.sendMessage({
            type: "GET_CONVERSATION_FOR_ACTIVE_TAB",
            windowId: currentWindow.id,
          });
          if (owned?.ok && owned.conversationId) {
            setActiveConversationId((prev) => prev ?? owned.conversationId);
          }
        } catch {}
        return;
      }
      if (allSpaces.length > 0) {
        setActiveSpaceId(allSpaces[0].id);
      }
    }
    init();

    const listener = () => {
      storage.getSpaces().then(setSpaces);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [isPopupMode, originWindowId]);

  useEffect(() => {
    let myWindowId: number | undefined;
    chrome.windows.getCurrent().then((w) => {
      myWindowId = w.id;
    });
    const handler = (msg: unknown) => {
      if (
        msg &&
        typeof msg === "object" &&
        (msg as { type?: string }).type === "FOCUS_CONVERSATION"
      ) {
        const m = msg as { windowId?: number; conversationId?: string | null };
        if (m.windowId != null && m.windowId === myWindowId) {
          setActiveConversationId(m.conversationId ?? null);
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  useEffect(() => {
    if (!activeConversationId) {
      setConversationTitle(null);
      return;
    }
    chatDb.getConversation(activeConversationId).then((conv) => {
      if (!conv) {
        // Defense in depth: the background command handler validates the
        // last-conversation id at launch time, and the broadcast listener
        // below handles live deletes from other windows. This catches any
        // remaining edge case where the conversation already disappeared
        // before the listener could fire (e.g. a concurrent delete during
        // popup launch).
        setActiveConversationId(null);
        setConversationTitle(null);
        return;
      }
      setConversationTitle(conv.title ?? null);
    });
  }, [activeConversationId]);

  // Live cross-window deletion: when another extension context (home tab,
  // detached popup, side panel) deletes a conversation, chatDb broadcasts
  // CONVERSATION_DELETED via chrome.runtime. If the deleted id is the one
  // we're currently viewing, reset to a fresh chat so the user doesn't end
  // up writing to a stale id that would silently resurrect the deleted row.
  useEffect(() => {
    function onMessage(msg: unknown) {
      if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { type?: unknown }).type === "CONVERSATION_DELETED"
      ) {
        const deletedId = (msg as { conversationId?: unknown }).conversationId;
        if (
          typeof deletedId === "string" &&
          deletedId === activeConversationIdRef.current
        ) {
          setActiveConversationId(null);
          setConversationTitle(null);
        }
      }
    }
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  // Mirror the active conversation title to document.title so popup windows
  // (both global and detached) show a meaningful name in their OS title bar
  // instead of a static "OpenBrowse". Side-panel mode doesn't render a
  // window title bar, so the effect is scoped to popup mode.
  useEffect(() => {
    if (!isPopupMode) return;
    document.title = conversationTitle ?? "OpenBrowse";
  }, [isPopupMode, conversationTitle]);

  useEffect(() => {
    function onGenerating(e: Event) {
      const id = (e as CustomEvent).detail?.id;
      if (id) setGeneratingTitleIds((prev) => new Set(prev).add(id));
    }
    function onUpdated(e: Event) {
      const { id, title } = (e as CustomEvent).detail ?? {};
      if (id) {
        setGeneratingTitleIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
        if (title && id === activeConversationIdRef.current) {
          setConversationTitle(title);
        }
      }
    }
    window.addEventListener("chat-title-generating", onGenerating);
    window.addEventListener("chat-title-updated", onUpdated);
    return () => {
      window.removeEventListener("chat-title-generating", onGenerating);
      window.removeEventListener("chat-title-updated", onUpdated);
    };
  }, []);

  const handleNewConversation = useCallback((id: string) => {
    if (id) {
      setActiveConversationId(id);
    } else {
      setActiveConversationId(null);
    }
  }, []);

  const handleNew = useCallback(() => {
    setActiveConversationId(null);
  }, []);

  // When this popup is the global-hotkey chat, persist the active
  // conversation id to session storage so the next press of Option+Space
  // restores the same conversation. Scoped to globalChat=true to avoid
  // colliding with the regular detached side panel popup.
  useEffect(() => {
    if (!isGlobalChat) return;
    if (activeConversationId) {
      chrome.storage.session
        .set({ globalChatLastConversationId: activeConversationId })
        .catch((err) => {
          console.warn("[global-chat] failed to persist conversation id:", err);
        });
    } else {
      chrome.storage.session
        .remove("globalChatLastConversationId")
        .catch((err) => {
          console.warn("[global-chat] failed to clear conversation id:", err);
        });
    }
  }, [isGlobalChat, activeConversationId]);

  const handleOpenFullView = useCallback(async () => {
    const currentWindow = await chrome.windows.getCurrent();
    const hash = activeConversationId ? `#${activeConversationId}` : "";
    chrome.runtime.sendMessage({
      type: "OVERLAY_GLOBAL_ACTION",
      action: "full-view",
      hash,
      windowId: isPopupMode && originWindowId != null ? originWindowId : currentWindow.id,
    });
  }, [activeConversationId, isPopupMode, originWindowId]);

  const handleExportChat = useCallback(async () => {
    if (!activeConversationId) return;
    const [conv, messages] = await Promise.all([
      chatDb.getConversation(activeConversationId),
      chatDb.getMessages(activeConversationId),
    ]);
    const lines = messages.map((m) => {
      const role = m.role === "user" ? "You" : "Assistant";
      const content = formatMessageAsMarkdown(m);
      if (!content) return null;
      return `## ${role}\n\n${content}`;
    }).filter(Boolean);
    const markdown = `# ${conv?.title ?? "Chat"}\n\n${lines.join("\n\n---\n\n")}`;
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${conv?.title ?? "chat"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [activeConversationId]);

  const [pickerOpen, setPickerOpen] = useState(false);

  const handleDetach = useCallback(async () => {
    const w = await chrome.windows.getCurrent();
    let tabId: number | null = null;
    let url: string | null = null;
    if (w.id != null) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
        tabId = tab?.id ?? null;
        url = tab?.url ?? null;
      } catch {}
    }
    await chrome.runtime.sendMessage({
      type: "DETACH_SIDEPANEL",
      activeConversationId,
      activeSpaceId,
      originWindowId: w.id ?? null,
      originTabId: tabId,
      originUrl: url,
    });
  }, [activeConversationId, activeSpaceId]);

  // The tab id we want to reattach to, kept up to date so the click handler
  // can call chrome.sidePanel.open({tabId}) synchronously off the user
  // gesture. Reattach only targets the exact origin tab the popup was
  // detached from. The global Option+Space popup has no origin tab, so
  // its reattach target is always null and the reattach button is rendered
  // disabled with an explanatory tooltip. We do NOT fall back to "active
  // tab in last-focused window" — that would silently attach to whichever
  // tab the user happens to have in front, which is surprising behavior.
  //
  // The ref is read synchronously inside the click handler (Chrome requires
  // a sync gesture for chrome.sidePanel.open). The parallel state mirrors
  // the same value to drive the button's disabled prop and tooltip text,
  // since refs don't trigger re-renders.
  const reattachTargetRef = useRef<number | null>(originTabId ?? null);
  const [canReattach, setCanReattach] = useState<boolean>(originTabId != null);

  useEffect(() => {
    if (!isPopupMode) return;

    let cancelled = false;
    async function compute() {
      let next: number | null = null;
      if (originTabId != null) {
        try {
          const t = await chrome.tabs.get(originTabId);
          if (t.id != null) next = t.id;
        } catch {
          // Origin tab was closed since detach; no fallback target.
        }
      }
      if (!cancelled) {
        reattachTargetRef.current = next;
        setCanReattach(next != null);
      }
    }

    compute();
    const refresh = () => compute();
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onRemoved.addListener(refresh);
    chrome.windows.onFocusChanged.addListener(refresh);
    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onRemoved.removeListener(refresh);
      chrome.windows.onFocusChanged.removeListener(refresh);
    };
  }, [isPopupMode, originTabId]);

  const handleReattach = useCallback(() => {
    // chrome.sidePanel.open() requires a synchronous user gesture. Read the
    // precomputed target from the ref and call open() inline — no awaits or
    // .then() continuations before it.
    //
    // Reattach is only valid when this popup was detached from a specific
    // tab that still exists. The button is rendered disabled when
    // reattachTargetRef is null, so this guard is unreachable in practice
    // — kept as a defensive no-op in case a stale gesture races the state.
    const tabId = reattachTargetRef.current;
    if (tabId == null) return;
    // Register the panel for this tab and open it. The manifest has no
    // default global panel, so setOptions is required before open().
    // Fire-and-forget; Chrome processes these sequentially.
    chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId }).catch(() => {});

    // Async cleanup: activate the target tab, focus its window, and close
    // the popup. Safe to do off-gesture since none of these require user
    // activation.
    void (async () => {
      chrome.runtime.sendMessage({ type: "MARK_USER_OPENED_SIDEPANEL", tabId }).catch(() => {});
      // Activate the target tab so the just-opened panel is visible.
      // Without this, if the user navigated to a different tab in the
      // origin window before reattaching, focusing the window alone
      // would leave that other tab active and the panel hidden (since
      // we registered the panel only for tabId).
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
      // Focus the window that owns the target tab. Read it from the tab
      // itself — relying on originWindowId can be stale (the tab may have
      // been moved between windows since detach), and we deliberately
      // avoid a "last focused window" fallback to keep behavior tied to
      // the actual origin.
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.windowId != null) {
          chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
        }
      } catch {}

      try {
        const popup = await chrome.windows.getCurrent();
        if (popup.id != null) await chrome.windows.remove(popup.id);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyN") {
        e.preventDefault();
        handleNew();
      }
      if (e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyH") {
        e.preventDefault();
        setPickerOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleNew]);

  return (
    <div className="flex flex-col h-screen">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <SpaceSwitcher spaces={spaces} activeSpaceId={activeSpaceId} />
        {conversationTitle && (
          <>
            <span className="text-muted-foreground text-xs">/</span>
            <span className={`text-xs truncate min-w-0 ${activeConversationId && generatingTitleIds.has(activeConversationId) ? "shimmer-text" : ""}`}>{conversationTitle}</span>
          </>
        )}
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleNew}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <MessageSquarePlus className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-1.5">
            New conversation
            <Kbd>⌥N</Kbd>
          </TooltipContent>
        </Tooltip>
        {!isPopupMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleDetach}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <PictureInPicture className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Detach to popover</TooltipContent>
          </Tooltip>
        )}
        {isPopupMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleReattach}
                disabled={!canReattach}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              >
                <PanelRight className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {canReattach
                ? "Reattach to side panel"
                : "Unable to attach. The original tab is closed or no active window is available."}
            </TooltipContent>
          </Tooltip>
        )}
        <ChatPicker
          spaceId={activeSpaceId}
          activeConversationId={activeConversationId}
          onSelect={(id) => setActiveConversationId(id)}
          onNew={handleNew}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <MoreVertical className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onClick={handleOpenFullView}>
              <ExternalLink className="size-3.5" />
              Open in full view
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openSettingsTab()}>
              <Settings className="size-3.5" />
              Settings
            </DropdownMenuItem>
            {activeConversationId && (
              <DropdownMenuItem onClick={handleExportChat}>
                <Download className="size-3.5" />
                Export chat
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 min-h-0">
        <ChatView
          conversationId={activeConversationId}
          spaceId={activeSpaceId}
          onNewConversation={handleNewConversation}
          showHeader={false}
          isPopupMode={isPopupMode}
          isGlobalChat={isGlobalChat}
          originWindowId={isPopupMode ? originWindowId : null}
          originTabId={isPopupMode ? originTabId : null}
          originUrl={isPopupMode ? originUrl : null}
        />
      </div>
    </div>
  );
}
