import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { memoryDb, type Memory } from "@/lib/memory-db";
import { storage } from "@/lib/storage";
import { Trash2, ChevronDown, ChevronRight } from "lucide-react";

function MemoryItem({
  memory,
  onDelete,
}: {
  memory: Memory;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-md p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <button
          className="flex items-start gap-2 text-left flex-1 min-w-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium truncate">{memory.title}</span>
            </div>
            {memory.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {memory.description}
              </p>
            )}
          </div>
        </button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
              <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete memory</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete "{memory.title}"? This action
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete(memory.id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {expanded && (
        <div className="ml-6 p-2 bg-muted rounded text-xs whitespace-pre-wrap break-words font-mono">
          {memory.content}
        </div>
      )}
    </div>
  );
}

export function MemoryTab() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [currentSpaceId, setCurrentSpaceId] = useState<string | null>(null);
  const [spaceName, setSpaceName] = useState<string>("Space");
  const [spaceIcon, setSpaceIcon] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const win = await chrome.windows.getCurrent();
        const spaces = await storage.getSpaces();
        const space = spaces.find((s) => s.windowId === win.id) ?? null;
        const spaceId = space?.id ?? null;
        setCurrentSpaceId(spaceId);
        setSpaceName(space?.name ?? "Space");
        setSpaceIcon(space?.icon ?? null);

        const all = await memoryDb.list(spaceId);
        setMemories(all);
      } catch {
        // If we can't get window/spaces, just load user memories
        const all = await memoryDb.list(null);
        setMemories(all);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleDelete = async (id: string) => {
    await memoryDb.delete(id);
    setMemories((prev) => prev.filter((m) => m.id !== id));
  };

  const userMemories = memories.filter((m) => m.spaceId === null);
  const spaceMemories = memories.filter((m) => m.spaceId === currentSpaceId && m.spaceId !== null);

  if (loading) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-muted-foreground">Loading memories...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* User Memories */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">User Memories</h2>
        {userMemories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No memories saved yet</p>
        ) : (
          <ScrollArea className="max-h-[300px]">
            <div className="flex flex-col gap-2 pr-2">
              {userMemories.map((m) => (
                <MemoryItem key={m.id} memory={m} onDelete={handleDelete} />
              ))}
            </div>
          </ScrollArea>
        )}
      </section>

      {/* Space Memories */}
      {currentSpaceId && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{spaceIcon && <span className="mr-1">{spaceIcon}</span>}{spaceName} Memories</h2>
          {spaceMemories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No memories saved yet</p>
          ) : (
            <ScrollArea className="max-h-[300px]">
              <div className="flex flex-col gap-2 pr-2">
                {spaceMemories.map((m) => (
                  <MemoryItem key={m.id} memory={m} onDelete={handleDelete} />
                ))}
              </div>
            </ScrollArea>
          )}
        </section>
      )}
    </div>
  );
}
