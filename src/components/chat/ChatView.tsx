import { ChatInput, type TabMentionAttrs, type ImagePreview } from "./ChatInput";
import { ChatMessage } from "./ChatMessage";
import { CompactionDivider } from "./CompactionDivider";
import { Logo } from "@/components/ui/logo";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { cn } from "@/lib/utils";
import { providers } from "@/registry/providers";
import {
  Settings2,
  MessageSquarePlus,
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  X,
  Sparkles,
  FileText,
  Link,
  HelpCircle,
} from "lucide-react";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TodoPanel } from "./TodoPanel";
import type { CompactionPart } from "@/lib/types";

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
   * Whether this ChatView is being rendered inside a detached popover window.
   * When true, the "Sharing [tab]" pill is anchored to the origin tab the
   * popover was detached from rather than the popover's own (extension) tab.
   */
  isPopupMode?: boolean;
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
}

export function ChatView({
  conversationId,
  spaceId,
  onNewConversation,
  onOpenConversations: _onOpenConversations,
  className,
  showBackButton,
  onBack,
  showHeader = true,
  isPopupMode = false,
  originWindowId,
  originTabId,
  originUrl,
}: ChatViewProps) {
  // Track the live origin tab id in popup mode. May change if the original
  // origin tab is closed and later restored from history (the URL matches a
  // freshly-opened tab in the origin window). Side-panel mode ignores this.
  const [liveOriginTabId, setLiveOriginTabId] = useState<number | null>(originTabId ?? null);

  useEffect(() => {
    setLiveOriginTabId(originTabId ?? null);
  }, [originTabId]);

  const {
    messages,
    input,
    setInput,
    isLoading,
    isStreaming,
    isCompacting,
    isConfigured,
    settings,
    agentSettings,
    handleSubmit,
    handleNew,
    handleRegenerate,
    confirmEdit,
    addToolApprovalResponse,
    setAgentModel,
    setThinkingSettings,
    stop,
    error,
    clearError,
  } = useAgentChat({
    conversationId,
    spaceId,
    onNewConversation,
    // In popup mode, host tab is the live origin tab (may be null if it
    // was closed and not yet restored). In side-panel mode, defer to
    // useAgentChat's auto-resolution from the active tab in the current
    // window (which, in per-tab mode, IS the host tab).
    hostTabIdOverride: isPopupMode ? liveOriginTabId : undefined,
  });

const providerModels = useMemo(() => {
    return providers
      .map((provider) => {
        const enabledModels = provider.models.filter((m) =>
          settings.enabledModels.includes(`${provider.id}:${m.id}`)
        );
        if (enabledModels.length === 0) return null;

        let enabled = true;
        if (provider.setup === "byok") {
          const config = settings.providerConfigs[provider.id] ?? {};
          const requiredFields = provider.configSchema?.filter((f) => f.required) ?? [];
          enabled = requiredFields.every((f) => !!config[f.key]);
        } else if (provider.setup === "web-llm") {
          enabled = enabledModels.some((m) => settings.downloadedModels.includes(m.id));
        }

        return {
          provider: provider.id,
          label: provider.name,
          models: enabledModels,
          enabled,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
  }, [settings.enabledModels, settings.providerConfigs, settings.downloadedModels]);

  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [preEditInput, setPreEditInput] = useState("");
  const [activeTab, setActiveTab] = useState<{ title: string; favicon: string; url: string } | null>(null);

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
          [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        }
        if (tab?.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith(chrome.runtime.getURL(""))) {
          setActiveTab({ title: tab.title ?? "Untitled", favicon: tab.favIconUrl ?? "", url: tab.url });
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
      const msg = messages.find((m) => m.id === messageId);
      if (!msg) return;
      const text = msg.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("")
        .split("\n\n-----\n\n<Mentioned tabs>")[0];
      setPreEditInput(input);
      setEditingMessageId(messageId);
      setInput(text);
    },
    [messages, input, setInput],
  );

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setInput(preEditInput);
  }, [preEditInput, setInput]);

  const handleEditSubmit = useCallback(
    (mentions: TabMentionAttrs[], images: ImagePreview[]) => {
      if (!editingMessageId) return;
      confirmEdit(editingMessageId, mentions, images);
      setEditingMessageId(null);
    },
    [editingMessageId, confirmEdit],
  );

  function openSettings() {
    chrome.tabs.create({ url: chrome.runtime.getURL("/settings.html") });
  }

  const showThinking =
    isLoading &&
    !isStreaming &&
    messages.length > 0 &&
    messages[messages.length - 1].role === "user";

  const editingIndex = editingMessageId
    ? messages.findIndex((m) => m.id === editingMessageId)
    : -1;

  return (
    <div className={cn("flex flex-col h-full", className)}>
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
            <button
              type="button"
              onClick={onSettingsClick}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Settings"
            >
              <Settings2 className="size-3.5" />
            </button>
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

      {/* Todo Panel */}
      <TodoPanel conversationId={conversationId} />

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
                      onClick={() => { setInput(label); }}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-left"
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message, i) => {
              // Compaction-user message: replace the bubble with a
              // CompactionDivider. The next assistant message in the
              // stream is the summary; we render its text inside the
              // divider's expand panel.
              const compactionPart = (
                message.parts as unknown as CompactionPart[]
              ).find((p) => p.type === "data-compaction");
              if (message.role === "user" && compactionPart) {
                const next = messages[i + 1];
                const summaryText =
                  next?.role === "assistant"
                    ? next.parts
                        .filter(
                          (p): p is { type: "text"; text: string } =>
                            (p as { type: string }).type === "text",
                        )
                        .map((p) => p.text)
                        .join("\n")
                        .trim()
                    : "";
                return (
                  <CompactionDivider
                    key={message.id}
                    summary={summaryText}
                    hiddenCount={i}
                    auto={compactionPart.data.auto}
                    overflow={compactionPart.data.overflow}
                  />
                );
              }

              // Assistant summary message: hide from the main chat. Its
              // content is shown via the divider's expand toggle. We
              // detect it structurally — the previous message is a
              // compaction-user.
              const prev = messages[i - 1];
              const prevIsCompactionUser =
                prev?.role === "user" &&
                prev.parts.some((p) => p.type === "data-compaction");
              if (message.role === "assistant" && prevIsCompactionUser) {
                return null;
              }

              const isLastAssistant =
                message.role === "assistant" &&
                isStreaming &&
                !messages.slice(i + 1).some((m) => m.role === "assistant");
              const isDimmed = editingIndex !== -1 && i >= editingIndex;
              return (
                <ChatMessage
                  key={message.id}
                  message={message}
                  isStreaming={isLastAssistant}
                  dimmed={isDimmed}
                  onRegenerate={
                    message.role === "assistant" && !isLoading && !editingMessageId
                      ? () => handleRegenerate(message.id)
                      : undefined
                  }
                  onToolApproval={addToolApprovalResponse}
                  onEdit={
                    message.role === "user" && !isLoading && !editingMessageId
                      ? () => startEdit(message.id)
                      : undefined
                  }
                />
              );
            })}
            {showThinking && <ThinkingIndicator />}
            {error && (
              <ErrorMessage
                error={error}
                onRetry={() => {
                  clearError();
                  handleSubmit();
                }}
                onDismiss={clearError}
              />
            )}
          </div>
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input */}
      <div className="p-2 max-w-3xl mx-auto w-full">
        {isCompacting && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground mb-1.5">
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
            <span>Compacting context...</span>
          </div>
        )}
        {activeTab && messages.length === 0 && !editingMessageId && (
          <div className="flex items-center gap-2 px-2 py-1.5 mb-1.5 rounded-md bg-accent/50">
            {activeTab.favicon && (
              <img src={activeTab.favicon} alt="" className="size-4 rounded-sm shrink-0" />
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
        {editingMessageId && (
          <div className="flex items-center justify-between px-2 py-1 mb-1.5 rounded-md bg-accent/50 text-xs text-muted-foreground">
            <span>Editing message</span>
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
        <ChatInput
          value={input}
          onChange={setInput}
          onSubmit={editingMessageId ? handleEditSubmit : handleSubmit}
          onStop={stop}
          isLoading={isLoading}
          disabled={!isConfigured}
          providerModels={providerModels}
          selectedModel={agentSettings.agentModel}
          onModelChange={setAgentModel}
          thinkingEnabled={agentSettings.thinkingEnabled}
          thinkingConfig={agentSettings.thinkingConfig}
          onThinkingChange={setThinkingSettings}
          selectedModelCapabilities={
            providers
              .flatMap((p) => p.models)
              .find((m) => m.id === agentSettings.agentModel)
              ?.capabilities
          }
          autoFocus
          focusTrigger={`${conversationId ?? "new"}-${editingMessageId ?? ""}`}
        />
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="rounded-lg px-3 py-2 bg-muted">
        <div className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse" />
          <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse [animation-delay:150ms]" />
          <span className="size-1.5 rounded-full bg-foreground/40 animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}

function ErrorMessage({
  error,
  onRetry,
  onDismiss,
}: {
  error: Error;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm border border-destructive/30 bg-destructive/5">
        <div className="flex items-start gap-2">
          <AlertCircle className="size-3.5 text-destructive shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs text-destructive font-medium">
              Something went wrong
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 break-words">
              {error.message}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <button
                type="button"
                onClick={onRetry}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <RefreshCw className="size-3" />
                Retry
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
