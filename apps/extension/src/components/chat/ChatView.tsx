import {
  ChatInput,
  type TabMentionAttrs,
  type Attachment,
} from "./ChatInput";
import { MessageList } from "./MessageList";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueItemAttachment,
  QueueItemContent,
  QueueItemFile,
  QueueItemImage,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Logo } from "@/components/ui/logo";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentChat } from "@/hooks/useAgentChat";
import { ConversationIdContext } from "@/lib/conversation-id-context";
import { useActiveAgents } from "@/hooks/useActiveAgents";
import { useProviders } from "@/hooks/useProviders";
import { useConfiguredModels } from "@/hooks/useConfiguredModels";
import { parseAttachedFiles } from "@/lib/chat/parse-attached-files";
import { openSettingsTab } from "@/lib/open-settings";
import { storage } from "@/lib/storage";
import type { Space } from "@/lib/types";
import { cn } from "@/lib/utils";
import { classifyFile } from "@/lib/vfs/file-classify";
import { CoworkBar } from "@/components/cowork/cowork-bar";
import { ChatInputHalo } from "@/components/chat/ChatInputHalo";
import {
  ArrowLeft,
  ArrowUp,
  FileText,
  HelpCircle,
  Link,
  MessageSquarePlus,
  Pencil,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface ChatViewProps {
  conversationId: string | null;
  spaceId: string | null;
  onNewConversation: (id: string) => void;
  onOpenConversations?: () => void;
  className?: string;
  showBackButton?: boolean;
  onBack?: () => void;
  showHeader?: boolean;
  /**
   * Optional handler for the header's settings button. Only relevant when
   * `showHeader` is true; the button is rendered unconditionally inside the
   * header but is a no-op without this handler.
   */
  onSettingsClick?: () => void;
  /**
   * Optional handler for the header's close button. The button only renders
   * when this prop is supplied (header use cases without a close action,
   * e.g. embedded panes, simply omit it).
   */
  onClose?: () => void;
  /**
   * Whether this ChatView is being rendered inside a detached popover window.
   * When true, the "Sharing [tab]" pill is anchored to the origin tab the
   * popover was detached from rather than the popover's own (extension) tab.
   */
  isPopupMode?: boolean;
  /**
   * Whether this ChatView is the global Option+Space popup. Distinct from
   * `isPopupMode` (which also covers detached side panel popups). When true,
   * the input draft is persisted to chrome.storage.session so it survives
   * dismiss/reopen cycles via the global hotkey.
   */
  isGlobalChat?: boolean;
  /**
   * The browser window the popover was detached from. Used as a fallback
   * for resolving the origin tab if the original origin tab was closed.
   */
  originWindowId?: number | null;
  /**
   * The tab the popover was detached from. The "Sharing [tab]" pill renders
   * this tab. When the tab is closed, the pill hides; when a tab matching
   * the origin URL reopens in the same window (e.g., user restores from
   * history), the pill reappears.
   */
  originTabId?: number | null;
  /**
   * The URL of the origin tab at detach time, used to detect restoration.
   */
  originUrl?: string | null;
  /**
   * Optional initial value for the chat input editor. Used by the "Try in
   * chat" flow from settings — when the home page opens with a `?prefill=`
   * URL parameter, this is forwarded down so the agent input is pre-populated
   * (e.g. with `/skill-name `).
   */
  initialInput?: string;
  /**
   * Whether the composer's cowork bar should surface Workspace files and
   * Context controls. Enabled in the side panel (which has no dedicated
   * rail); the home view leaves this off because its RightRail already
   * renders the Working folder and Context cards.
   */
  showWorkspaceControls?: boolean;
}

export function ChatView({
  conversationId,
  spaceId,
  onNewConversation,
  onOpenConversations: _onOpenConversations,
  onSettingsClick,
  onClose,
  className,
  showBackButton,
  onBack,
  showHeader = true,
  isPopupMode = false,
  isGlobalChat = false,
  originWindowId,
  originTabId,
  originUrl,
  showWorkspaceControls = false,
  initialInput,
}: ChatViewProps) {
  // Track the live origin tab id in popup mode. May change if the original
  // origin tab is closed and later restored from history (the URL matches a
  // freshly-opened tab in the origin window). Side-panel mode ignores this.
  const [liveOriginTabId, setLiveOriginTabId] = useState<number | null>(
    originTabId ?? null,
  );

  useEffect(() => {
    setLiveOriginTabId(originTabId ?? null);
  }, [originTabId]);

  // The "Sharing X" pill in the side panel binds to this state. The
  // mirroring ref lets `getSharedTabId` read the latest value without
  // being re-created (and thus without destabilizing the `useCallback`s
  // in `useAgentChat` that list it as a dependency).
  const [activeTab, setActiveTab] = useState<{
    id: number;
    title: string;
    favicon: string;
    url: string;
  } | null>(null);
  const activeTabRef = useRef<typeof activeTab>(null);
  activeTabRef.current = activeTab;

  // Stable identity: reads the live tab via the ref, so an empty dep
  // array is correct and keeps downstream callbacks memoized.
  const getSharedTabId = useCallback(
    () => activeTabRef.current?.id ?? null,
    [],
  );

  const activeAgents = useActiveAgents();
  const isAgentActiveGlobally = conversationId ? activeAgents.has(conversationId) : false;

  const {
    messages,
    input,
    setInput,
    isLoading: hookIsLoading,
    isStreaming: hookIsStreaming,
    isCompacting,
    isConfigured,
    settings,
    updateSettings,
    agentSettings,
    handleSubmit,
    compactNow,
    handleNew,
    handleRetry,
    handleRetryFromUser,
    confirmEdit,
    approveToolCall,
    isViewer,
    setAgentModel,
    setThinkingSettings,
    stop,
    error,
    clearError,
    queue,
    queueMessage,
    removeQueued,
    updateQueued,
    clearQueue,
    setQueueEditing,
  } = useAgentChat({
    conversationId: conversationId ?? null,
    spaceId: spaceId ?? null,
    onNewConversation,
    initialInput,
    getSharedTabId,
  });

  // Seed the composer from an external "seed-chat-input" event (e.g. the
  // per-chat "Schedule" action inserting "/schedule "). Scoped to the active
  // conversation so only the visible chat responds. Bumps a focus nonce so
  // ChatInput refocuses on the seeded text.
  const [seedNonce, setSeedNonce] = useState(0);
  useEffect(() => {
    function onSeed(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { conversationId: string | null; text: string }
        | undefined;
      if (!detail) return;
      if ((detail.conversationId ?? null) !== (conversationId ?? null)) return;
      setInput(detail.text);
      setSeedNonce((n) => n + 1);
    }
    window.addEventListener("seed-chat-input", onSeed);
    return () => window.removeEventListener("seed-chat-input", onSeed);
  }, [conversationId, setInput]);

  // Resolve the active space's row so the bottom composer can paint
  // its color halo on focus. Refetches when `spaceId` changes or when
  // the spaces list mutates from another extension surface (rename,
  // color change, etc.).
  const [space, setSpace] = useState<Space | null>(null);
  useEffect(() => {
    if (!spaceId) {
      setSpace(null);
      return;
    }
    let cancelled = false;
    async function load() {
      const all = await storage.getSpaces();
      if (cancelled) return;
      setSpace(all.find((s) => s.id === spaceId) ?? null);
    }
    load();
    function onChanged(changes: Record<string, unknown>) {
      if ("spaces" in changes) load();
    }
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [spaceId]);

  const isLoading = hookIsLoading || isAgentActiveGlobally;
  const isStreaming = hookIsStreaming || isAgentActiveGlobally;

  // Viewer-aware stop. In a viewer tab there is no live local loop to
  // abort — the run is driven by the host. Forward a stop request via
  // the existing AGENT_STOP broadcast, which the host's listener honors.
  // (New messages typed in a viewer already route to the queue because
  // `isLoading` is true, so ChatInput queues instead of submitting; the
  // host drains the queue. So only stop needs special handling here.)
  const handleStop = useCallback(() => {
    if (isViewer) {
      try {
        chrome.runtime?.sendMessage?.({ type: "AGENT_STOP" })?.catch?.(() => {});
      } catch {
        /* ignore */
      }
      return;
    }
    stop();
  }, [isViewer, stop]);

  const { providers } = useProviders();

  const providerModels = useConfiguredModels(settings);

  // Auto-select a default model when none is set and at least one
  // provider is now configured. Mirrors the same effect in LandingPage
  // so that whichever surface the user lands on after entering their
  // first API key gets a sensible model selected automatically.
  //
  // Without this, the model-selector trigger renders empty and the
  // chat input stays disabled until the user manually picks a model,
  // which made the post-config UX feel broken.
  useEffect(() => {
    if (agentSettings.agentModel) return;
    if (providerModels.length === 0) return;

    const isAvailable = (key: string) => {
      const [pid, ...rest] = key.split(":");
      const mid = rest.join(":");
      return providerModels.some(
        (g) => g.provider === pid && g.models.some((m) => m.id === mid),
      );
    };

    let pick: string | null = null;

    const favorite = settings.favoriteModels.find(isAvailable);
    if (favorite) pick = favorite;

    if (!pick) {
      for (const group of providerModels) {
        const rec = group.models.find((m) => m.recommended);
        if (rec) {
          pick = `${group.provider}:${rec.id}`;
          break;
        }
      }
    }

    if (!pick) {
      const group = providerModels[0];
      const model = group?.models[0];
      if (group && model) pick = `${group.provider}:${model.id}`;
    }

    if (pick) setAgentModel(pick);
  }, [
    providerModels,
    agentSettings.agentModel,
    settings.favoriteModels,
    setAgentModel,
  ]);

  /**
   * Editing state. `kind === "sent"` edits a message already in the
   * transcript (writes through `confirmEdit` → chatDb). `kind === "queued"`
   * edits a queued-but-not-yet-sent message (writes through
   * `updateQueued` → queueDb). Mutually exclusive — one editor, one mode.
   */
  const [editing, setEditing] = useState<
    { kind: "sent" | "queued"; id: string } | null
  >(null);
  const [preEditInput, setPreEditInput] = useState("");

  // Mirror the latest input/messages into refs so the per-message
  // callbacks (startEdit) can read them without listing them as deps.
  // Keeping startEdit's identity stable across keystrokes is what lets
  // the memoized <MessageList> skip re-rendering while the user types.
  const inputRef = useRef(input);
  inputRef.current = input;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    if (!isPopupMode) return;
    if (originUrl == null || originWindowId == null) return;

    // If the origin tab is gone (closed or never set), watch for a tab in
    // the origin window matching originUrl — the user may restore via
    // Cmd+Shift+T or history. Adopt the new tabId when it appears.
    function adoptIfMatch(tab: chrome.tabs.Tab | undefined) {
      if (!tab || tab.id == null) return false;
      if (tab.windowId !== originWindowId) return false;
      if (tab.url !== originUrl) return false;
      setLiveOriginTabId(tab.id);
      return true;
    }

    const onCreated = (tab: chrome.tabs.Tab) => {
      if (liveOriginTabId != null) return; // still alive
      adoptIfMatch(tab);
    };
    const onUpdated = (
      _id: number,
      _info: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (liveOriginTabId != null) return;
      adoptIfMatch(tab);
    };
    const onRemoved = (id: number) => {
      if (id === liveOriginTabId) setLiveOriginTabId(null);
    };

    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    return () => {
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
  }, [isPopupMode, originUrl, originWindowId, liveOriginTabId]);

  useEffect(() => {
    async function refresh() {
      try {
        let tab: chrome.tabs.Tab | undefined;
        if (isPopupMode) {
          // Popup pill is anchored to the origin tab. If origin tab is gone
          // (and not yet restored), the pill hides — no fallback to the
          // origin window's currently-active tab.
          if (liveOriginTabId == null) {
            setActiveTab(null);
            return;
          }
          try {
            tab = await chrome.tabs.get(liveOriginTabId);
          } catch {
            setLiveOriginTabId(null);
            setActiveTab(null);
            return;
          }
        } else {
          [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
        }
        if (
          tab?.id != null &&
          tab?.url &&
          !tab.url.startsWith("chrome://") &&
          !tab.url.startsWith(chrome.runtime.getURL(""))
        ) {
          setActiveTab({
            id: tab.id,
            title: tab.title ?? "Untitled",
            favicon: tab.favIconUrl ?? "",
            url: tab.url,
          });
        } else {
          setActiveTab(null);
        }
      } catch {
        setActiveTab(null);
      }
    }
    refresh();
    const onActivated = () => refresh();
    const onUpdated = (id: number) => {
      if (isPopupMode) {
        if (liveOriginTabId != null && id === liveOriginTabId) refresh();
      } else {
        refresh();
      }
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [isPopupMode, liveOriginTabId]);

  const startEdit = useCallback(
    (messageId: string) => {
      const msg = messagesRef.current.find((m) => m.id === messageId);
      if (!msg) return;
      const text = msg.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("")
        .split("\n\n-----\n\n<Mentioned tabs>")[0];
      setPreEditInput(inputRef.current);
      setEditing({ kind: "sent", id: messageId });
      setInput(text);
    },
    [setInput],
  );

  const startEditQueued = useCallback(
    (queuedId: string) => {
      const item = queue.find((q) => q.id === queuedId);
      if (!item) return;
      setPreEditInput(input);
      setEditing({ kind: "queued", id: queuedId });
      // The QueuedMessage's `text` is the user's raw input pre-mention,
      // pre-attachment-block — exactly what we want to repopulate.
      setInput(item.text);
      // Pause auto-flush so the item we're editing isn't drained out
      // from under us between status flipping to ready and the user
      // clicking Save. Cleared on cancel/save.
      setQueueEditing(queuedId);
    },
    [queue, input, setInput, setQueueEditing],
  );

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setInput(preEditInput);
    setQueueEditing(null);
  }, [preEditInput, setInput, setQueueEditing]);

  const handleEditSubmit = useCallback(
    (mentions: TabMentionAttrs[], attachments: Attachment[]) => {
      if (!editing) return;
      if (editing.kind === "sent") {
        confirmEdit(editing.id, mentions, attachments);
      } else {
        // Queue edits update the persisted text only. Re-attaching files
        // or changing mentions on a queued item is a v2 concern — for
        // now, the queued mention/attachment snapshot is preserved as
        // captured at queue time. The new text replaces the old text.
        updateQueued(editing.id, { text: input.trim() });
      }
      setEditing(null);
      setInput(preEditInput);
      setQueueEditing(null);
    },
    [editing, confirmEdit, updateQueued, input, preEditInput, setInput, setQueueEditing],
  );

  function openSettings() {
    void openSettingsTab();
  }

  const showThinking =
    isLoading &&
    !isStreaming &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "user";

  // Sent-message edits dim everything below the edited row. Queued
  // edits don't affect the transcript, so they don't dim anything.
  const editingIndex =
    editing?.kind === "sent"
      ? messages.findIndex((m) => m.id === editing.id)
      : -1;

  const isEditing = editing !== null;

  return (
    <ConversationIdContext.Provider value={conversationId ?? null}>
    <div className={cn("flex flex-col h-full pt-1", className)}>
      {/* Header */}
      {showHeader && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="flex items-center gap-1">
            {showBackButton && onBack && (
              <button
                type="button"
                onClick={onBack}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground mr-1"
                title="Back"
              >
                <ArrowLeft className="size-3.5" />
              </button>
            )}
            <span className="text-xs font-medium">Chat</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleNew}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="New conversation"
            >
              <MessageSquarePlus className="size-3.5" />
            </button>
            {onSettingsClick && (
              <button
                type="button"
                onClick={onSettingsClick}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Settings"
              >
                <Settings2 className="size-3.5" />
              </button>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Close"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <Conversation className="flex-1">
        <ConversationContent className="p-3">
          <div className="max-w-3xl mx-auto space-y-3 w-full">
            {!isConfigured && messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
                <p className="text-sm text-muted-foreground">
                  Set up an AI model to start chatting
                </p>
                <button
                  type="button"
                  onClick={openSettings}
                  className="text-xs text-primary hover:underline"
                >
                  Open settings
                </button>
              </div>
            )}
            {isConfigured && messages.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-4 text-center px-4 min-h-[calc(100vh-180px)]">
                <Logo className="size-10" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">OpenBrowse</p>
                  <p className="text-xs text-muted-foreground">
                    Ask about the current page, or anything else
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 w-full max-w-[280px]">
                  {[
                    { icon: FileText, label: "Summarize this page" },
                    { icon: HelpCircle, label: "Explain this page" },
                    { icon: Sparkles, label: "Find key points" },
                    { icon: Link, label: "Extract all links" },
                  ].map(({ icon: Icon, label }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        setInput(label);
                      }}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-left"
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(messages.length > 0 || showThinking || error) && (
              <MessageList
                messages={messages}
                isStreaming={isStreaming}
                isLoading={isLoading}
                isEditing={isEditing}
                editingIndex={editingIndex}
                showThinking={showThinking}
                error={error}
                onEdit={startEdit}
                onRetryFromUser={handleRetryFromUser}
                onToolApproval={approveToolCall}
                onRetry={handleRetry}
                onDismissError={clearError}
              />
            )}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input */}
      <div className="p-2 max-w-3xl mx-auto w-full">
        <CoworkBar
          key={conversationId ?? "none"}
          conversationId={conversationId ?? null}
          spaceId={spaceId ?? null}
          showWorkspaceControls={showWorkspaceControls}
        />
        {isCompacting && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground mb-1.5">
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
            <span>Compacting context...</span>
          </div>
        )}
        {activeTab && messages.length === 0 && !isEditing && (
          <div className="flex items-center gap-2 px-2 py-1.5 mb-1.5 rounded-md bg-accent/50">
            {activeTab.favicon && (
              <img
                src={activeTab.favicon}
                alt=""
                className="size-4 rounded-sm shrink-0"
              />
            )}
            <span className="text-xs text-muted-foreground truncate min-w-0">
              Sharing &ldquo;{activeTab.title}&rdquo;
            </span>
            <button
              type="button"
              onClick={() => setActiveTab(null)}
              className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
        {editing && (
          <div className="flex items-center justify-between px-2 py-1 mb-1.5 rounded-md bg-accent/50 text-xs text-muted-foreground">
            <span>
              {editing.kind === "queued"
                ? "Editing queued message"
                : "Editing message"}
            </span>
            <button
              type="button"
              onClick={cancelEdit}
              className="flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground transition-colors"
            >
              <X className="size-3" />
              Cancel
            </button>
          </div>
        )}
        {queue.length > 0 && (
          <Queue className="mb-1.5">
            <QueueSection defaultOpen>
              <QueueSectionTrigger>
                <QueueSectionLabel
                  count={queue.length}
                  label={queue.length === 1 ? "Queued" : "Queued"}
                />
                {/* Clear-queue affordance: only meaningful when there are
                    actually multiple items, but render unconditionally so the
                    surface is discoverable even with a single queued item. */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearQueue();
                  }}
                  className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Clear queue"
                >
                  Clear
                </button>
              </QueueSectionTrigger>
              <QueueSectionContent>
                <QueueList>
                  {queue.map((item) => {
                    const isThisEdited =
                      editing?.kind === "queued" && editing.id === item.id;
                    // Image vision-files render as thumbnails directly from
                    // their data URLs. Non-image attachments come out of the
                    // `<Attached files>` block we synthesized at queue time;
                    // we filter classified-image paths because those are
                    // already covered by visionFiles (and an image that
                    // exceeds the vision cap is intentionally dropped — same
                    // behavior as UserMessage's chip row).
                    const { attachedPaths } = parseAttachedFiles(
                      item.attachmentBlock,
                    );
                    const nonImagePaths = attachedPaths.filter((p) => {
                      const name = p.split("/").pop() ?? p;
                      return classifyFile(name) !== "image";
                    });
                    const hasAttachments =
                      item.visionFiles.length > 0 || nonImagePaths.length > 0;
                    return (
                      <QueueItem
                        key={item.id}
                        className={
                          isThisEdited
                            ? "bg-accent/40 ring-1 ring-primary/30"
                            : undefined
                        }
                      >
                        <QueueItemIndicator />
                        {item.text && (
                          <QueueItemContent>{item.text}</QueueItemContent>
                        )}
                        {hasAttachments && (
                          <QueueItemAttachment>
                            {item.visionFiles.map((vf, i) => (
                              <QueueItemImage
                                key={`img-${i}`}
                                src={vf.url}
                              />
                            ))}
                            {nonImagePaths.map((path) => {
                              const name = path.split("/").pop() ?? path;
                              return (
                                <QueueItemFile key={path}>{name}</QueueItemFile>
                              );
                            })}
                          </QueueItemAttachment>
                        )}
                        <QueueItemActions>
                          {isThisEdited ? (
                            <span className="text-[10px] text-muted-foreground italic px-1">
                              editing
                            </span>
                          ) : (
                            <>
                              {isLoading &&
                                !editing &&
                                queue[0]?.id === item.id && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <QueueItemAction
                                        onClick={() => stop()}
                                        aria-label="Send now"
                                      >
                                        <ArrowUp className="size-3" />
                                      </QueueItemAction>
                                    </TooltipTrigger>
                                    <TooltipContent side="bottom">
                                      Send now
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              <QueueItemAction
                                onClick={() => startEditQueued(item.id)}
                                title="Edit"
                              >
                                <Pencil className="size-3" />
                              </QueueItemAction>
                              <QueueItemAction
                                onClick={() => removeQueued(item.id)}
                                title="Remove"
                              >
                                <X className="size-3" />
                              </QueueItemAction>
                            </>
                          )}
                        </QueueItemActions>
                      </QueueItem>
                    );
                  })}
                </QueueList>
              </QueueSectionContent>
            </QueueSection>
          </Queue>
        )}
        <ChatInputHalo space={space}>
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={isEditing ? handleEditSubmit : handleSubmit}
            onQueue={isEditing ? undefined : queueMessage}
            onCommand={
              isEditing
                ? undefined
                : async ({ command, hasRemaining, mentions, attachments }) => {
                    if (command !== "compact") return;
                    // Compact first; the transport prunes against the
                    // fresh compaction state on the next send.
                    await compactNow();
                    // Compact-then-send: if the user typed text alongside
                    // `/compact`, send it now. ChatInput already stripped
                    // the command node and synced `input` to the leftover
                    // text, so handleSubmit picks it up.
                    if (hasRemaining) {
                      await handleSubmit(mentions, attachments);
                    }
                  }
            }
            editMode={isEditing}
            onStop={handleStop}
            isLoading={isLoading}
            disabled={!isConfigured}
            providerModels={providerModels}
            favoriteModels={settings.favoriteModels}
            onFavoriteToggle={(modelKey) => {
              const favoriteModels = settings.favoriteModels.includes(modelKey)
                ? settings.favoriteModels.filter((k) => k !== modelKey)
                : [...settings.favoriteModels, modelKey];
              updateSettings({ favoriteModels });
            }}
            selectedModel={agentSettings.agentModel}
            onModelChange={setAgentModel}
            thinkingEnabled={agentSettings.thinkingEnabled}
            thinkingConfig={agentSettings.thinkingConfig}
            onThinkingChange={setThinkingSettings}
            selectedModelCapabilities={(() => {
              const parts = agentSettings.agentModel.split(":");
              const hasProvider = parts.length > 1;
              const targetProviderId = hasProvider ? parts[0] : undefined;
              const actualId = hasProvider ? parts.slice(1).join(":") : agentSettings.agentModel;
              const provider = providers.find((p) =>
                hasProvider
                  ? p.id === targetProviderId
                  : p.models.some((m) => m.id === actualId),
              );
              return provider?.models.find((m) => m.id === actualId)?.capabilities;
            })()}
            autoFocus
            focusTrigger={`${conversationId ?? "new"}-${editing?.id ?? ""}-${seedNonce}`}
          />
        </ChatInputHalo>
      </div>
    </div>
    </ConversationIdContext.Provider>
  );
}

