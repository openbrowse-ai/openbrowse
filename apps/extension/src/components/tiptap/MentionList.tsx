import { MessageSquare } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

/**
 * A single `@`-mention target. Both tabs and past chats are surfaced under the
 * same `@` trigger; `kind` discriminates which node the suggestion inserts and
 * which context block it ultimately injects.
 */
export type MentionItem =
  | { kind: "tab"; id: string; title: string; url: string; favicon: string }
  | { kind: "chat"; id: string; title: string; updatedAt: number };

interface MentionListProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
}

export interface MentionListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

/** Short relative-time label ("2h", "3d") for a chat's last activity. */
function relativeTime(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 52) return `${wk}w`;
  return `${Math.floor(day / 365)}y`;
}

export const MentionList = forwardRef<MentionListRef, MentionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;
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
          <p className="text-xs text-muted-foreground">
            No matching tabs or chats
          </p>
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-border bg-popover py-1 shadow-md max-h-72 overflow-y-auto w-72">
        {items.map((item, index) => {
          // Items arrive grouped (all tabs, then all chats). Emit a section
          // header whenever the kind changes so the flat, single-cursor list
          // still reads as two labelled groups.
          const showHeader = index === 0 || items[index - 1].kind !== item.kind;
          const isSelected = index === selectedIndex;
          return (
            <div key={`${item.kind}:${item.id}`}>
              {showHeader && (
                <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {item.kind === "tab" ? "Tabs" : "Past chats"}
                </p>
              )}
              <button
                type="button"
                onClick={() => command(item)}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                  isSelected ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                {item.kind === "tab" ? (
                  item.favicon ? (
                    <img
                      src={item.favicon}
                      alt=""
                      className="size-4 shrink-0 rounded-sm"
                    />
                  ) : (
                    <div className="size-4 shrink-0 rounded-sm bg-muted" />
                  )
                ) : (
                  <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{item.title}</p>
                  {item.kind === "tab" && (
                    <p className="text-[10px] text-muted-foreground truncate">
                      {item.url}
                    </p>
                  )}
                </div>
                {item.kind === "chat" && (
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {relativeTime(item.updatedAt)}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    );
  },
);

MentionList.displayName = "MentionList";
