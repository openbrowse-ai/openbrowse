import { useState } from "react";
import { EmojiPicker } from "frimousse";
import { PlusIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SpaceColorPicker } from "@/entrypoints/overlay/components/SpaceColorPicker";
import type { Space } from "@/lib/types";

/**
 * Frimousse-based emoji picker, styled to fit a small popover. Shared by
 * everywhere a Space is rename-able: the create dialog, the LandingPage's
 * editable hero, and any future surface.
 */
export function CompactEmojiPicker({
  onSelect,
}: {
  onSelect: (emoji: string) => void;
}) {
  return (
    <EmojiPicker.Root
      onEmojiSelect={(emoji) => onSelect(emoji.emoji)}
      className="isolate flex h-[280px] w-[280px] flex-col"
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

/**
 * Button-shaped icon picker. Shows the current icon (or a placeholder) and
 * opens a popover containing the frimousse emoji picker on click.
 *
 * Two callers today: the small inline create form (`size="sm"`, h-8/w-8)
 * and the per-space configuration UI (`size="md"`, h-9/w-9). The
 * editable hero on LandingPage uses `size="hero"`, a much larger button
 * sized to match the space title font scale.
 */
export function IconPickerButton({
  icon,
  onChange,
  size = "md",
  ariaLabel = "Choose space icon",
}: {
  icon: string | null;
  onChange: (icon: string | null) => void;
  size?: "sm" | "md" | "hero";
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const sizeClass =
    size === "sm"
      ? "h-8 w-8 text-base"
      : size === "hero"
        ? "h-16 w-16 text-4xl"
        : "h-9 w-9 text-lg";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={`${sizeClass} shrink-0 flex items-center justify-center rounded-md border border-input/30 bg-muted hover:bg-accent transition-colors`}
        >
          {icon ?? "😀"}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-0 overflow-hidden"
      >
        <CompactEmojiPicker
          onSelect={(emoji) => {
            onChange(emoji);
            setOpen(false);
          }}
        />
        {icon && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="flex w-full items-center justify-center gap-1 border-t border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            Remove icon
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Renders a colored-dot button (the current space color, or a neutral
 * placeholder if unset) that opens a dialog containing `<SpaceColorPicker>`.
 * Inline color picking was visually heavy in the detail view, so we surface
 * it on demand.
 */
export function ColorPickerDialog({
  space,
  systemDark,
  onSave,
  size = "md",
}: {
  space: Space;
  systemDark: boolean;
  onSave: (
    colors: string[] | null,
    colorMode: "auto" | "light" | "dark" | null,
  ) => void | Promise<void>;
  size?: "md" | "hero";
}) {
  const [open, setOpen] = useState(false);

  const dotBackground = space.colors
    ? space.colors.length === 1
      ? space.colors[0]
      : `linear-gradient(135deg, ${space.colors.join(", ")})`
    : undefined;

  const sizeClass = size === "hero" ? "h-5 w-5" : "h-6 w-6";
  const placeholderIconSize = size === "hero" ? "size-3" : "size-2.5";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Choose space color"
          className={`${sizeClass} shrink-0 rounded-full border border-input/30 hover:ring-2 hover:ring-ring/30 transition-shadow`}
          style={
            dotBackground
              ? { background: dotBackground }
              : { background: "transparent" }
          }
        >
          {!dotBackground && (
            <span
              className="flex h-full w-full items-center justify-center text-muted-foreground"
            >
              <PlusIcon className={placeholderIconSize} aria-hidden />
            </span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Space color</DialogTitle>
        </DialogHeader>
        <SpaceColorPicker
          initialColors={space.colors}
          initialColorMode={space.colorMode}
          systemDark={systemDark}
          onPreview={() => {
            // No live preview surface inside the dialog; previews would
            // have no visible target. Save commits the change.
          }}
          onSave={async (colors, colorMode) => {
            await onSave(colors, colorMode);
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
