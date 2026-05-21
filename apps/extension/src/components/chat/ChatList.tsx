import { chatDb } from "@/lib/chat-db";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ChatListProps {
  spaceId: string | null;
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onBack?: () => void;
}

interface ConversationItem {
  id: string;
  title: string;
  spaceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export function ChatList({
  spaceId,
  activeConversationId,
  onSelect,
  onNew,
  onBack,
}: ChatListProps) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const convs = await chatDb.listConversations(spaceId);
    setConversations(convs);
  }, [spaceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Cross-window conversation lifecycle: refetch when another extension
  // context (popup, side panel, home tab) creates, updates, or deletes a
  // conversation. Broadcasts are field-filtered at chatDb so this doesn't
  // fire on per-message `updatedAt` bumps.
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

  function handleDeleteClick(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setDeleteTarget(id);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await chatDb.deleteConversation(deleteTarget);
    setDeleteTarget(null);
    await refresh();
  }

  function formatTime(ts: number) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-1">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Back"
            >
              <ArrowLeft className="size-3.5" />
            </button>
          )}
          <span className="text-xs font-medium text-muted-foreground">Chats</span>
        </div>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3" />
          New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto styled-scrollbar">
        {conversations.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            No chats yet
          </div>
        )}
        {conversations.map((conv) => (
          <button
            key={conv.id}
            type="button"
            onClick={() => onSelect(conv.id)}
            className={`group flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
              conv.id === activeConversationId ? "bg-accent" : ""
            }`}
          >
            <div className="flex-1 truncate">
              <div className="truncate text-xs">{conv.title}</div>
              <div className="text-[10px] text-muted-foreground">
                {formatTime(conv.updatedAt)}
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => handleDeleteClick(e, conv.id)}
              className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:block"
            >
              <Trash2 className="size-3" />
            </button>
          </button>
        ))}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent
          onKeyDown={(e) => {
            if (e.metaKey && e.key === "Enter") {
              e.preventDefault();
              confirmDelete();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this chat. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
              <kbd className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] opacity-60">
                <span>⌘</span><span>↵</span>
              </kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
