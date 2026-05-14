import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

export interface TabSuggestionItem {
  id: string;
  title: string;
  url: string;
  favicon: string;
}

interface TabMentionListProps {
  items: TabSuggestionItem[];
  command: (item: TabSuggestionItem) => void;
}

export interface TabMentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const TabMentionList = forwardRef<TabMentionListRef, TabMentionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="rounded-lg border border-border bg-popover p-2 shadow-md">
          <p className="text-xs text-muted-foreground">No matching tabs</p>
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-border bg-popover py-1 shadow-md max-h-60 overflow-y-auto w-72">
        {items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => command(item)}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
              index === selectedIndex ? "bg-accent text-accent-foreground" : ""
            }`}
          >
            {item.favicon ? (
              <img src={item.favicon} alt="" className="size-4 shrink-0 rounded-sm" />
            ) : (
              <div className="size-4 shrink-0 rounded-sm bg-muted" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs truncate">{item.title}</p>
              <p className="text-[10px] text-muted-foreground truncate">{item.url}</p>
            </div>
          </button>
        ))}
      </div>
    );
  },
);

TabMentionList.displayName = "TabMentionList";
