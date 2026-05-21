import { EmojiPicker } from "frimousse";
import { Palette, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

interface ConfigureSpaceViewProps {
  name: string;
  icon: string | null;
  colors: string[] | null;
  openTabCount?: number;
  onUpdateName: (name: string) => void;
  onUpdateIcon: (icon: string | null) => void;
  onEditColor: () => void;
  onRemoveColor: () => void;
  onDeleteSpace: () => void;
}

function CompactEmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <EmojiPicker.Root
      onEmojiSelect={(emoji) => onSelect(emoji.emoji)}
      className="isolate flex h-[280px] w-full flex-col"
    >
      <EmojiPicker.Search
        autoFocus
        className="z-10 mx-2 mt-2 rounded-md bg-muted px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        placeholder="Search emoji..."
      />
      <EmojiPicker.Viewport className="relative flex-1 outline-hidden">
        <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading...
        </EmojiPicker.Loading>
        <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          No emoji found.
        </EmojiPicker.Empty>
        <EmojiPicker.List
          className="select-none pb-1.5"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                {...props}
                className="bg-popover px-3 pt-3 pb-1.5 text-xs font-medium text-muted-foreground"
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div className="scroll-my-1.5 px-1.5" {...props}>
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                className="flex size-8 items-center justify-center rounded-md text-lg data-[active]:bg-muted"
                {...props}
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </EmojiPicker.Viewport>
    </EmojiPicker.Root>
  );
}

export function ConfigureSpaceView({
  name,
  icon,
  colors,
  openTabCount = 0,
  onUpdateName,
  onUpdateIcon,
  onEditColor,
  onRemoveColor,
  onDeleteSpace,
}: ConfigureSpaceViewProps) {
  const [localName, setLocalName] = useState(name);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingWithTabs, setConfirmingWithTabs] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleNameBlur = () => {
    const trimmed = localName.trim();
    if (trimmed && trimmed !== name) {
      onUpdateName(trimmed);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      handleNameBlur();
      inputRef.current?.blur();
    }
  };

  const colorPreview = colors
    ? colors.length === 1
      ? colors[0]
      : `linear-gradient(135deg, ${colors.join(", ")})`
    : undefined;

  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setEmojiOpen((prev) => !prev)}
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-base hover:bg-accent transition-colors"
        >
          {icon ?? "😀"}
        </button>
        <input
          ref={inputRef}
          value={localName}
          onChange={(e) => setLocalName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={handleNameKeyDown}
          placeholder="Space name"
          className="flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
      </div>

      {emojiOpen && (
        <div className="mt-2 rounded-lg border border-border overflow-hidden">
          <CompactEmojiPicker
            onSelect={(emoji) => {
              onUpdateIcon(emoji);
              setEmojiOpen(false);
              inputRef.current?.focus();
            }}
          />
        </div>
      )}

      <button
        onClick={onEditColor}
        className="mt-3 flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-sm hover:bg-muted transition-colors"
      >
        {colorPreview ? (
          <div
            className="size-5 shrink-0 rounded-full border border-border"
            style={{ background: colorPreview }}
          />
        ) : (
          <Palette className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 text-left">
          {colors ? "Edit theme color" : "Add theme color"}
        </span>
      </button>

      {colors && (
        <button
          onClick={onRemoveColor}
          className="mt-1 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:text-destructive hover:bg-muted transition-colors"
        >
          <Trash2 className="size-3.5" />
          Remove color
        </button>
      )}

      {confirmingWithTabs ? (
        <div className="mt-4 space-y-2 rounded-md border border-destructive/30 px-2.5 py-2">
          <p className="text-sm text-destructive">
            This will close {openTabCount} open {openTabCount === 1 ? "tab" : "tabs"} and the window. Continue?
          </p>
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => { setConfirmingWithTabs(false); setConfirmingDelete(false); }}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onDeleteSpace}
              className="rounded-md bg-destructive px-2 py-1 text-xs text-destructive-foreground hover:bg-destructive/90 transition-colors"
            >
              Delete &amp; close tabs
            </button>
          </div>
        </div>
      ) : confirmingDelete ? (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-destructive/30 px-2.5 py-2">
          <span className="flex-1 text-sm text-destructive">Delete this space?</span>
          <button
            onClick={() => setConfirmingDelete(false)}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (openTabCount > 0) {
                setConfirmingWithTabs(true);
              } else {
                onDeleteSpace();
              }
            }}
            className="rounded-md bg-destructive px-2 py-1 text-xs text-destructive-foreground hover:bg-destructive/90 transition-colors"
          >
            Delete
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirmingDelete(true)}
          className="mt-4 flex w-full items-center gap-2.5 rounded-md border border-destructive/30 px-2.5 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
        >
          <Trash2 className="size-4" />
          Delete space
        </button>
      )}
    </div>
  );
}
