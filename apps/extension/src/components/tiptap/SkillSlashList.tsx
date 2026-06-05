import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

export interface SkillSuggestionItem {
  /** Skill name as stored in OPFS / shown to the user. */
  name: string;
  /** Frontmatter description (used for the secondary line). */
  description: string;
  /**
   * Whether this entry is a built-in command (local action, e.g.
   * `/compact`) or a user skill. Defaults to "skill" when omitted.
   */
  kind?: "command" | "skill";
}

interface SkillSlashListProps {
  items: SkillSuggestionItem[];
  command: (item: SkillSuggestionItem) => void;
}

export interface SkillSlashListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const SkillSlashList = forwardRef<SkillSlashListRef, SkillSlashListProps>(
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
          <p className="text-xs text-muted-foreground">No matching commands or skills</p>
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-border bg-popover py-1 shadow-md max-h-60 overflow-y-auto w-80">
        {items.map((item, index) => {
          const kind = item.kind ?? "skill";
          const prevKind = index > 0 ? items[index - 1].kind ?? "skill" : null;
          const showHeader = kind !== prevKind;
          return (
            <div key={`${kind}:${item.name}`}>
              {showHeader && (
                <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {kind === "command" ? "Commands" : "Skills"}
                </p>
              )}
              <button
                type="button"
                onClick={() => command(item)}
                className={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left transition-colors ${
                  index === selectedIndex ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium font-mono">/{item.name}</p>
                  <p className="text-[10px] text-muted-foreground line-clamp-2">
                    {item.description}
                  </p>
                </div>
              </button>
            </div>
          );
        })}
      </div>
    );
  },
);

SkillSlashList.displayName = "SkillSlashList";
