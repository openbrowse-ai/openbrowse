import { formatMessageAsMarkdown } from "@/lib/format-markdown";
import { openSettingsTab } from "@/lib/open-settings";
import { chatDb } from "@/lib/chat-db";
import { storage } from "@/lib/storage";
import type { Space } from "@/lib/types";
import { useTheme } from "@/hooks/useTheme";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatView } from "@/components/chat/ChatView";
import { ChatPicker } from "@/components/chat/ChatPicker";
import { CopyIcon, Download, ExternalLink, FileDown, MessageSquarePlus, MoreVertical, Settings, PictureInPicture, PanelRight } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { ContextUsage } from "@/components/chat/ContextUsage";
import { FileViewerPanel } from "@/components/files/FileViewerPanel";
import { FileSelectionContext } from "@/lib/file-selection-context";
import { loadArtifact } from "@/lib/artifacts/registry";
import { takePendingFixRequest, pollPendingFixRequest } from "@/lib/artifacts/pending-fix-request";
import { parsePopupParams } from "./parsePopupParams";
import { toast } from "sonner";

function readPopupParams() {
  if (typeof window === "undefined") {
    return {
      isPopupMode: false,
      isGlobalChat: false,
      originWindowId: null,
      originTabId: null,
      originUrl: null,
      initialConversationId: null,
      editArtifactId: null,
      seedPrompt: null,
      autoSubmit: false,
    };
  }
  return parsePopupParams(window.location.search);
}

export default function App() {
  useTheme();
  const { isPopupMode, isGlobalChat, originWindowId, originTabId, originUrl, initialConversationId, editArtifactId, seedPrompt, autoSubmit } = readPopupParams();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(initialConversationId);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const [editingArtifactId, setEditingArtifactId] = useState<string | null>(null);
  const [generatingTitleIds, setGeneratingTitleIds] = useState<Set<string>>(new Set());
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  // Pending composer seed (from the artifact "Fix with OpenBrowse" banner),
  // delivered once the matching conversation is active and ChatView has bound
  // its "seed-chat-input" listener. Dispatched by the effect below.
  //
  // `conversationId` is `null` for the "Edit this artifact in chat" flows:
  // the conversation row is created lazily on first send (so abandoning the
  // edit panel leaves no empty row in the sidebar), so the seed targets the
  // pre-creation null-conversation state. ChatView compares with `?? null`,
  // so a null here matches its not-yet-created active chat.
  const [pendingSeed, setPendingSeed] = useState<
    { conversationId: string | null; text: string; autoSubmit: boolean } | null
  >(null);

  // Synchronous in-progress guard for the "Edit this artifact in chat" flow.
  // React.StrictMode runs the init effect twice on mount with no render in
  // between, so a render-coupled check cannot stop the second run from also
  // loading the artifact + queuing the seed. This ref is flipped true
  // synchronously before the await, deduping both the StrictMode double-mount
  // and the concurrent-await race. (No DB row is created here — see
  // useAgentChat's lazy createConversation, which tags the row with
  // editingArtifactId on first send.)
  const loadingEditArtifactRef = useRef(false);

  // Holds the artifact id while "Edit this artifact in chat" is active but the
  // conversation hasn't been created yet (deferred to first send). The title
  // effect keys on activeConversationId; when that's null this ref tells it to
  // preserve edit mode instead of resetting editingArtifactId to null. Cleared
  // once a real conversation id is adopted, or when edit mode ends.
  const pendingEditArtifactRef = useRef<string | null>(null);

  // Workspace-relative path of the file open in the full-panel viewer.
  const [viewerFile, setViewerFile] = useState<string | null>(null);

  // FileSelectionContext handler: any file click (the composer's cowork bar
  // or transcript chips) opens the in-panel viewer.
  const handleSelectFile = useCallback((file: string | null) => {
    setViewerFile(file);
  }, []);

  // Reset the viewer when switching conversations.
  useEffect(() => {
    setViewerFile(null);
  }, [activeConversationId]);

  // Escape dismisses the viewer overlay.
  useEffect(() => {
    if (viewerFile === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewerFile(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewerFile]);

  useEffect(() => {
    async function init() {
      const allSpaces = await storage.getSpaces();
      setSpaces(allSpaces);

      // "Edit this artifact in chat": when launched with ?editArtifactId and
      // no explicit conversation, enter edit mode WITHOUT creating a
      // conversation row. The row is created lazily by useAgentChat on first
      // send (tagged with editingArtifactId), so opening the edit panel and
      // closing it without typing leaves nothing in the sidebar. Here we only
      // set the local edit state + composer seed.
      async function maybeEnterEditMode() {
        if (!editArtifactId) return;
        if (initialConversationId) return;
        if (activeConversationIdRef.current) return;
        // Synchronous bail: a prior invocation (StrictMode double-mount or a
        // concurrent code path) is already setting up edit mode.
        if (loadingEditArtifactRef.current) return;
        // Claim the in-progress slot synchronously, before any await, so the
        // second StrictMode run sees it set and bails above.
        loadingEditArtifactRef.current = true;

        // No active conversation yet — edit mode runs in the fresh-chat state.
        pendingEditArtifactRef.current = editArtifactId;
        setActiveConversationId(null);
        setEditingArtifactId(editArtifactId);

        let artifactTitle = "artifact";
        try {
          const a = await loadArtifact(editArtifactId);
          if (a) artifactTitle = a.manifest.title;
        } catch (err) {
          console.warn("[sidepanel] failed to load artifact for edit mode:", err);
        }
        setConversationTitle(`Edit: ${artifactTitle}`);

        // Seed the composer. Prefer the "Fix with OpenBrowse" prompt stashed in
        // chrome.storage.local by the artifact tab (polled briefly because the
        // artifact fires the async write then opens the panel). Falls back to
        // the URL `seedPrompt`. The seed targets the null (not-yet-created)
        // conversation; sending it triggers useAgentChat's lazy create.
        try {
          const reqd = await pollPendingFixRequest();
          if (reqd && reqd.artifactId === editArtifactId) {
            setPendingSeed({ conversationId: null, text: reqd.prompt, autoSubmit: reqd.autoSubmit !== false });
          } else if (seedPrompt) {
            setPendingSeed({ conversationId: null, text: seedPrompt, autoSubmit });
          }
        } catch {
          if (seedPrompt) {
            setPendingSeed({ conversationId: null, text: seedPrompt, autoSubmit });
          }
        }
      }

      if (isPopupMode) {
        if (originWindowId != null) {
          const space = await storage.getSpaceByWindowId(originWindowId);
          setActiveSpaceId(space?.id ?? null);
          await maybeEnterEditMode();
          return;
        }
        // No origin window → run space-less.
        setActiveSpaceId(null);
        await maybeEnterEditMode();
        return;
      }

      const currentWindow = await chrome.windows.getCurrent();
      if (currentWindow.id) {
        const space = await storage.getSpaceByWindowId(currentWindow.id);
        setActiveSpaceId(space?.id ?? null);

        // When launched to edit an artifact, edit mode takes priority over
        // whatever conversation the active tab owns. Adopting the tab's owned
        // conversation first would set activeConversationId, making
        // maybeEnterEditMode bail on its guard — so the agent would run in an
        // ordinary conversation with no editingArtifactId and never receive
        // the artifact's HTML. Skip the adoption in that case.
        if (editArtifactId) {
          await maybeEnterEditMode();
          return;
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
        await maybeEnterEditMode();
        return;
      }
      setActiveSpaceId(null);
      await maybeEnterEditMode();
    }
    init();

    const listener = () => {
      storage.getSpaces().then(setSpaces);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [isPopupMode, originWindowId, editArtifactId, initialConversationId]);

  // Deliver a queued composer seed once its conversation is the active one.
  // ChatView (re)binds its "seed-chat-input" listener whenever conversationId
  // changes; by the time this effect runs the listener is bound for the active
  // conversation. We dispatch on a macrotask that is intentionally NOT canceled
  // by the effect cleanup — clearing `pendingSeed` re-renders immediately, and
  // an rAF/cleanup-canceled timer would be aborted before it ever fired.
  useEffect(() => {
    if (!pendingSeed) return;
    if (activeConversationId !== pendingSeed.conversationId) return;
    const seed = pendingSeed;
    setPendingSeed(null);
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent("seed-chat-input", {
          detail: {
            conversationId: seed.conversationId,
            text: seed.text,
            autoSubmit: seed.autoSubmit,
          },
        }),
      );
    }, 0);
  }, [pendingSeed, activeConversationId]);

  // React to "Fix with OpenBrowse" requests written by an artifact tab into
  // chrome.storage.local (see pending-fix-request.ts — session storage is
  // context-partitioned, so the artifact tab and this side panel wouldn't see
  // each other's values). This works even when the side panel was already
  // open (chrome.sidePanel.open doesn't reload an open panel, so init() and
  // its URL-param handling don't re-run). Each request enters edit mode for a
  // fresh chat and queues the (auto-submitted) seed prompt; the conversation
  // row is created lazily by useAgentChat on send, so no empty row appears if
  // the request is somehow abandoned.
  useEffect(() => {
    let cancelled = false;

    async function startFromFixRequest() {
      const reqd = await takePendingFixRequest();
      if (cancelled || !reqd) return;
      let artifactTitle = "artifact";
      try {
        const a = await loadArtifact(reqd.artifactId);
        if (a) artifactTitle = a.manifest.title;
      } catch {
        /* fall back to generic title */
      }
      if (cancelled) return;
      // Enter edit mode in the fresh-chat (null conversation) state. Set the
      // pending edit-artifact id BEFORE clearing the active conversation so the
      // title effect (which keys on activeConversationId) surfaces edit mode
      // rather than resetting it.
      pendingEditArtifactRef.current = reqd.artifactId;
      setActiveConversationId(null);
      setEditingArtifactId(reqd.artifactId);
      setConversationTitle(`Edit: ${artifactTitle}`);
      setPendingSeed({
        conversationId: null,
        text: reqd.prompt,
        autoSubmit: reqd.autoSubmit !== false,
      });
    }

    function onChanged(
      changes: Record<string, chrome.storage.StorageChange>,
    ) {
      if (!changes["openbrowse:pending-fix-request"]) return;
      const next = changes["openbrowse:pending-fix-request"].newValue as
        | { artifactId?: string }
        | undefined;
      if (!next) return; // ignore our own clear (remove)
      // Cold-open is handled by init's maybeEnterEditMode (it polls storage
      // for the same request). If this panel was launched for this very
      // artifact, defer to init to avoid double-handling. The warm-panel case
      // (request for an artifact we weren't launched for, or panel already
      // settled) is handled here.
      if (editArtifactId && next.artifactId === editArtifactId && !activeConversationIdRef.current) {
        return;
      }
      void startFromFixRequest();
    }

    chrome.storage.local.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.local.onChanged.removeListener(onChanged);
    };
  }, []);

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
        // In edit-artifact mode the conversation is fixed to the edit
        // conversation; ignore tab-focus-driven conversation switches that
        // would otherwise replace it (and strip the editingArtifactId
        // context the agent needs).
        if (editArtifactId) return;
        const m = msg as { windowId?: number; conversationId?: string | null };
        if (m.windowId != null && m.windowId === myWindowId) {
          setActiveConversationId(m.conversationId ?? null);
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [editArtifactId]);

  useEffect(() => {
    if (!activeConversationId) {
      // Pre-send "Edit this artifact in chat" state: no conversation row
      // exists yet (created lazily on first send), but we must keep edit mode
      // so ChatView shows the editing banner and useAgentChat tags the row.
      if (pendingEditArtifactRef.current) {
        setEditingArtifactId(pendingEditArtifactRef.current);
        return;
      }
      setConversationTitle(null);
      setEditingArtifactId(null);
      return;
    }
    // A real conversation id is now active; the deferred edit state (if any)
    // has been promoted onto the persisted row, so stop preserving it here.
    pendingEditArtifactRef.current = null;
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
        setEditingArtifactId(null);
        return;
      }
      setConversationTitle(conv.title ?? null);
      setEditingArtifactId(conv.editingArtifactId ?? null);
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

  const buildChatMarkdown = useCallback(async () => {
    if (!activeConversationId) return null;
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
    return { markdown, title: conv?.title ?? "chat" };
  }, [activeConversationId]);

  const handleCopyChatMarkdown = useCallback(async () => {
    const built = await buildChatMarkdown();
    if (!built) return;
    try {
      await navigator.clipboard.writeText(built.markdown);
      toast.success("Chat copied as markdown");
    } catch {
      toast.error("Failed to copy chat");
    }
  }, [buildChatMarkdown]);

  const handleExportChat = useCallback(async () => {
    const built = await buildChatMarkdown();
    if (!built) return;
    const blob = new Blob([built.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${built.title}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildChatMarkdown]);

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
    <FileSelectionContext.Provider value={handleSelectFile}>
      <div className="relative flex flex-col h-screen">
        <div className="relative flex items-center gap-1.5 border-b border-border px-2 py-1.5">
          {conversationTitle && (
            <span className={`text-xs truncate min-w-0 ${activeConversationId && generatingTitleIds.has(activeConversationId) ? "shimmer-text" : ""}`}>{conversationTitle}</span>
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
          {activeConversationId && (
            <ContextUsage conversationId={activeConversationId} compact />
          )}
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
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Download className="size-3.5" />
                    Export chat
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent
                      sideOffset={4}
                      className="min-w-44"
                    >
                      <DropdownMenuItem onClick={handleCopyChatMarkdown}>
                        <CopyIcon className="size-3.5" />
                        Copy markdown
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleExportChat}>
                        <FileDown className="size-3.5" />
                        Export as .md
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
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
            showWorkspaceControls
            isPopupMode={isPopupMode}
            isGlobalChat={isGlobalChat}
            originWindowId={isPopupMode ? originWindowId : null}
            originTabId={isPopupMode ? originTabId : null}
            originUrl={isPopupMode ? originUrl : null}
            editingArtifactId={editingArtifactId}
          />
        </div>
        {viewerFile !== null && activeConversationId && (
          <div className="absolute inset-0 z-50 bg-background">
            <FileViewerPanel
              filePath={`conversations/${activeConversationId}/workspace/${viewerFile}`}
              fileName={viewerFile.split("/").pop() ?? viewerFile}
              conversationId={activeConversationId}
              spaceId={activeSpaceId}
              onClose={() => setViewerFile(null)}
            />
          </div>
        )}
      </div>
    </FileSelectionContext.Provider>
  );
}
