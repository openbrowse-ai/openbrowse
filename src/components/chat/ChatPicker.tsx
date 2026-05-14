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
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { chatDb } from "@/lib/chat-db";
import { History, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface ChatPickerProps {
  spaceId: string | null;
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface ConversationItem {
  id: string;
  title: string;
  spaceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export function ChatPicker({
  spaceId,
  activeConversationId,
  onSelect,
  onNew,
  open: controlledOpen,
  onOpenChange,
}: ChatPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    setInternalOpen(v);
    onOpenChange?.(v);
  };
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const convs = await chatDb.listConversations(spaceId);
    setConversations(convs);
  }, [spaceId]);

  useEffect(() => {
    if (open) {
      refresh();
    }
  }, [open, refresh]);

  function formatTime(ts: number) {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function handleSelect(id: string) {
    onSelect(id);
    setOpen(false);
  }

  function handleDeleteClick(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    e.preventDefault();
    setDeleteTarget(id);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await chatDb.deleteConversation(deleteTarget);
    setDeleteTarget(null);
    await refresh();
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <History className="size-3.5" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-1.5">
            Chat history
            <Kbd>⌥H</Kbd>
          </TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-64 p-0">
          <Command
            className="gap-0 p-0.5 *:data-[slot=command-input-wrapper]:p-0.5 *:data-[slot=command-input-wrapper]:pb-0"
            filter={(value, search) => {
              const conv = conversations.find((c) => c.id === value);
              if (!conv) return 0;
              return conv.title.toLowerCase().includes(search.toLowerCase())
                ? 1
                : 0;
            }}
          >
            <CommandInput placeholder="Search chats..." />
            <CommandList>
              <CommandEmpty>No chats found.</CommandEmpty>
              <CommandGroup className="px-0.5 py-1">
                {conversations.map((conv) => (
                  <CommandItem
                    key={conv.id}
                    value={conv.id}
                    onSelect={() => handleSelect(conv.id)}
                    className="group/item"
                    data-checked={conv.id === activeConversationId}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-xs">{conv.title}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {formatTime(conv.updatedAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => handleDeleteClick(e, conv.id)}
                      className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover/item:block"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
            <CommandSeparator />
            <CommandGroup className="p-0.5 pt-1">
              <CommandItem
                onSelect={() => {
                  onNew();
                  setOpen(false);
                }}
              >
                <Plus className="size-3.5" />
                <span className="text-xs">New chat</span>
              </CommandItem>
            </CommandGroup>
          </Command>
        </PopoverContent>
      </Popover>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
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
              This will permanently delete this chat. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
              <kbd className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] opacity-60">
                <span>⌘</span>
                <span>↵</span>
              </kbd>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
