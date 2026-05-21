import { EmojiPicker } from "frimousse";
import { useRef, useState } from "react";

interface CreateSpaceFormProps {
  onSubmit: (name: string, icon: string | null) => void;
  submitRef?: React.MutableRefObject<(() => void) | null>;
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

export function CreateSpaceForm({ onSubmit, submitRef }: CreateSpaceFormProps) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (submitRef) {
    submitRef.current = name.trim() ? () => onSubmit(name.trim(), icon) : null;
  }

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
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              e.preventDefault();
              e.stopPropagation();
              onSubmit(name.trim(), icon);
            }
          }}
          placeholder="Space name"
          className="flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
      </div>
      {emojiOpen && (
        <div className="mt-2 rounded-lg border border-border overflow-hidden">
          <CompactEmojiPicker
            onSelect={(emoji) => {
              setIcon(emoji);
              setEmojiOpen(false);
              inputRef.current?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
}
