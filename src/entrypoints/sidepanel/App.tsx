import { chatDb } from "@/lib/chat-db";
import { storage } from "@/lib/storage";
import type { Space } from "@/lib/types";
import { useTheme } from "@/hooks/useTheme";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChatView } from "@/components/chat/ChatView";
import { ChatPicker } from "@/components/chat/ChatPicker";
import { SpaceSwitcher } from "./components/SpaceSwitcher";
import { Download, ExternalLink, Link as LinkIcon, MessageSquarePlus, MoreVertical, Settings } from "lucide-react";
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

export default function App() {
  useTheme();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState<string | null>(null);
  const [generatingTitleIds, setGeneratingTitleIds] = useState<Set<string>>(new Set());
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  useEffect(() => {
    async function init() {
      const allSpaces = await storage.getSpaces();
      setSpaces(allSpaces);

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
            setActiveConversationId(owned.conversationId);
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
      setConversationTitle(conv?.title ?? null);
    });
  }, [activeConversationId]);

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

  const [activeTab, setActiveTab] = useState<{ tabId: number; pinned: boolean; windowId: number } | null>(null);
  useEffect(() => {
    async function refreshActiveTab() {
      const w = await chrome.windows.getCurrent();
      if (w.id == null) return;
      const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
      if (tab?.id != null) {
        setActiveTab({ tabId: tab.id, pinned: tab.pinned === true, windowId: w.id });
      } else {
        setActiveTab(null);
      }
    }
    refreshActiveTab();
    const onActivated = () => refreshActiveTab();
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (info.pinned != null || info.status === "complete") refreshActiveTab();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  const handleBindActiveTab = useCallback(async () => {
    if (!activeConversationId || !activeTab || activeTab.pinned) return;
    await chrome.runtime.sendMessage({
      type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
      conversationId: activeConversationId,
      tabId: activeTab.tabId,
    });
  }, [activeConversationId, activeTab]);

  const handleOpenFullView = useCallback(async () => {
    const currentWindow = await chrome.windows.getCurrent();
    const hash = activeConversationId ? `#${activeConversationId}` : "";
    chrome.runtime.sendMessage({
      type: "OVERLAY_GLOBAL_ACTION",
      action: "full-view",
      hash,
      windowId: currentWindow.id,
    });
  }, [activeConversationId]);

  const handleExportChat = useCallback(async () => {
    if (!activeConversationId) return;
    const [conv, messages] = await Promise.all([
      chatDb.getConversation(activeConversationId),
      chatDb.getMessages(activeConversationId),
    ]);
    const lines = messages.map((m) => {
      const role = m.role === "user" ? "You" : "Assistant";
      const partTexts: string[] = [];
      for (const part of m.parts) {
        if (part.type === "text" && part.text.trim()) {
          partTexts.push(part.text);
        } else if (
          part.type === "dynamic-tool" ||
          (typeof part.type === "string" && part.type.startsWith("tool-") && "toolCallId" in part && "input" in part)
        ) {
          const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
          const p = part as Record<string, unknown>;
          const input = p.input as Record<string, unknown> | undefined;
          const hasOutput = p.state === "output-available" && "output" in p;
          const output = hasOutput ? p.output : undefined;

          if (toolName === "screenshot") {
            partTexts.push(`**Tool: screenshot**\n\n[Screenshot captured — image data redacted]`);
            continue;
          }

          if (toolName === "executeCode" || toolName === "executeOnPage") {
            const code = typeof input?.code === "string" ? input.code : "";
            const sections = [`**Tool: ${toolName}**\n\n\`\`\`javascript\n${code}\n\`\`\``];
            if (hasOutput) {
              const out = output as { result?: unknown; logs?: string[]; error?: string } | undefined;
              if (out?.error) {
                sections.push(`**Error:** ${out.error}`);
              } else if (out?.result !== undefined) {
                sections.push(`**Result:** ${typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2)}`);
              }
              if (out?.logs && out.logs.length > 0) {
                sections.push(`**Logs:**\n\`\`\`\n${out.logs.join("\n")}\n\`\`\``);
              }
            }
            partTexts.push(sections.join("\n\n"));
            continue;
          }

          const header = `**Tool: ${toolName}**`;
          const inputStr = input ? `**Input:**\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`` : "";
          const outputStr = hasOutput ? `**Output:**\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`` : "";
          partTexts.push([header, inputStr, outputStr].filter(Boolean).join("\n\n"));
        }
      }
      if (partTexts.length === 0) return null;
      return `## ${role}\n\n${partTexts.join("\n\n")}`;
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
        {activeConversationId && activeTab && !activeTab.pinned && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleBindActiveTab}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <LinkIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Work on this tab</TooltipContent>
          </Tooltip>
        )}
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
            <DropdownMenuItem onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("/settings.html") })}>
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
        />
      </div>
    </div>
  );
}
