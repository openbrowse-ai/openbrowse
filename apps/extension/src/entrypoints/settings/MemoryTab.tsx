import { useEffect, useState } from "react";
import { MemoryItem } from "@/components/memory/MemoryItem";
import { memoryDb, type Memory } from "@/lib/memory-db";
import { storage } from "@/lib/storage";

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
          <div className="flex flex-col gap-2">
            {userMemories.map((m) => (
              <MemoryItem key={m.id} memory={m} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </section>

      {/* Space Memories */}
      {currentSpaceId && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{spaceIcon && <span className="mr-1">{spaceIcon}</span>}{spaceName} Memories</h2>
          {spaceMemories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No memories saved yet</p>
          ) : (
            <div className="flex flex-col gap-2">
              {spaceMemories.map((m) => (
                <MemoryItem key={m.id} memory={m} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
