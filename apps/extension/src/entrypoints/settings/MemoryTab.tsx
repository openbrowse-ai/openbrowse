import { MemoryBrowser } from "@/components/memory/MemoryBrowser";
import { MemorySyncSection } from "./memory-sync/MemorySyncSection";
import { storage } from "@/lib/storage";
import { useEffect, useState } from "react";

export function MemoryTab({
  selectedNote,
  onSelectNote,
}: {
  /** URL-backed note path (`?note=`), owned by `SettingsPage`. */
  selectedNote: string | null;
  onSelectNote: (path: string | null) => void;
}) {
  const [currentSpaceId, setCurrentSpaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const win = await chrome.windows.getCurrent();
        const spaces = await storage.getSpaces();
        const space = spaces.find((s) => s.windowId === win.id) ?? null;
        setCurrentSpaceId(space?.id ?? null);
      } catch {
        setCurrentSpaceId(null);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        Loading memory...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <MemorySyncSection />
      <div className="flex-1 min-h-0">
        <MemoryBrowser
          variant="sidebar"
          spaceId={currentSpaceId}
          selectedPath={selectedNote}
          onSelectedPathChange={onSelectNote}
        />
      </div>
    </div>
  );
}
