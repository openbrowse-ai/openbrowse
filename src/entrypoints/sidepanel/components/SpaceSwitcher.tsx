import { Popover } from "radix-ui";
import { ChevronDown, Plus, Settings } from "lucide-react";
import type { Space } from "@/lib/types";
import { useEffect, useRef, useState } from "react";

interface SpaceSwitcherProps {
  spaces: Space[];
  activeSpaceId: string | null;
}

export function SpaceSwitcher({ spaces, activeSpaceId }: SpaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const activeSpace = spaces.find((s) => s.id === activeSpaceId);

  const filtered = spaces
    .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => a.position - b.position);

  function selectSpace(spaceId: string) {
    chrome.runtime.sendMessage({ type: "SWITCH_SPACE", spaceId, openSidePanel: true });
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlighted]) selectSpace(filtered[highlighted].id);
    }
  }

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlighted(0);
    } else {
      const idx = filtered.findIndex((s) => s.id === activeSpaceId);
      if (idx >= 0) setHighlighted(idx);
    }
  }, [open]);

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = listRef.current?.children[highlighted] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [highlighted]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="shrink-0 flex items-center gap-0.5 rounded-md px-1 py-0.5 text-sm hover:bg-accent transition-colors"
          title={activeSpace?.name ?? "Switch space"}
        >
          <span className="size-5 flex items-center justify-center">
            {activeSpace?.icon || activeSpace?.name.charAt(0) || "S"}
          </span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 w-52 rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 overflow-hidden animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onKeyDown={handleKeyDown}
        >
          <div className="p-1">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search spaces..."
              autoFocus
              className="w-full rounded-md border border-input/30 bg-input/30 px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring/50"
            />
          </div>
          <div ref={listRef} className="max-h-48 overflow-y-auto p-1">
            {filtered.map((space, i) => (
              <button
                key={space.id}
                type="button"
                onClick={() => selectSpace(space.id)}
                onMouseEnter={() => setHighlighted(i)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                  i === highlighted ? "bg-accent text-accent-foreground" : ""
                } ${space.id === activeSpaceId ? "font-medium" : ""}`}
              >
                <span className="shrink-0 w-5 text-center">
                  {space.icon || space.name.charAt(0)}
                </span>
                <span className="truncate">{space.name}</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground text-center">
                No spaces found
              </p>
            )}
          </div>
          <div className="border-t border-border p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                chrome.runtime.sendMessage({ type: "OPEN_OVERLAY_ACTION", action: "configure-space" });
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Settings className="shrink-0 size-4" />
              <span>Configure space</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                chrome.runtime.sendMessage({ type: "OPEN_OVERLAY_ACTION", action: "new-space" });
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Plus className="shrink-0 size-4" />
              <span>New space</span>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
