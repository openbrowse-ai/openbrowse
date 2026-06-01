import type { OverlayTab } from "../OverlayApp";
import type { Space } from "@/lib/types";
import { Kbd } from "@/components/ui/kbd";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { ArrowRightFromLine, ChevronRight, Copy, Pencil, Pin, PinOff, Star, StarOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface ActionsPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: OverlayTab | null;
  isFavorited: boolean;
  otherSpaces: Space[];
  onAction: (action: string) => void;
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  rename: Pencil,
  favorite: Star,
  unfavorite: StarOff,
  pin: Pin,
  unpin: PinOff,
  copy: Copy,
  close: X,
  move: ArrowRightFromLine,
};

export function ActionsPopover({
  open,
  onOpenChange,
  tab,
  isFavorited,
  otherSpaces,
  onAction,
}: ActionsPopoverProps) {
  const [moveOpen, setMoveOpen] = useState(false);
  const moveItemRef = useRef<HTMLDivElement>(null);
  const skipCloseRef = useRef(false);

  useEffect(() => {
    if (!open) setMoveOpen(false);
  }, [open]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && skipCloseRef.current) {
      skipCloseRef.current = false;
      return;
    }
    if (!next) setMoveOpen(false);
    onOpenChange(next);
  }, [onOpenChange]);

  const actions = useMemo(() => {
    if (!tab) return [];
    const list: { id: string; label: string }[] = [
      { id: "rename", label: "Rename" },
      ...(tab.pinned
        ? [{ id: "unpin", label: "Unpin" }]
        : [
            isFavorited
              ? { id: "unfavorite", label: "Unfavorite" }
              : { id: "favorite", label: "Favorite" },
            { id: "pin", label: "Pin" },
          ]),
    ];
    if (otherSpaces.length > 0) {
      list.push({ id: "move", label: "Move to…" });
    }
    list.push(
      { id: "copy", label: "Copy URL" },
      { id: "close", label: "Close tab" },
    );
    return list;
  }, [tab, isFavorited, otherSpaces]);

  const items = useMemo(() => actions.map((a) => a.id), [actions]);
  const actionsById = useMemo(() => {
    const map = new Map<string, (typeof actions)[number]>();
    for (const a of actions) map.set(a.id, a);
    return map;
  }, [actions]);
  const itemToStringLabel = useMemo(
    () => (id: string) => actionsById.get(id)?.label ?? id,
    [actionsById],
  );

  const spaceItems = useMemo(() => otherSpaces.map((s) => s.id), [otherSpaces]);
  const spacesById = useMemo(() => {
    const map = new Map<string, Space>();
    for (const s of otherSpaces) map.set(s.id, s);
    return map;
  }, [otherSpaces]);
  const spaceToStringLabel = useMemo(
    () => (id: string) => spacesById.get(id)?.name ?? id,
    [spacesById],
  );

  const openMoveSubmenu = useCallback(() => {
    skipCloseRef.current = true;
    setMoveOpen(true);
  }, []);

  const closeMoveSubmenu = useCallback(() => {
    setMoveOpen(false);
    requestAnimationFrame(() => {
      const popup = moveItemRef.current?.closest("[data-slot=combobox-content]");
      const input = popup?.querySelector("input");
      input?.focus();
    });
  }, []);

  const handleKeyDownCapture = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" && moveItemRef.current?.hasAttribute("data-highlighted")) {
      e.preventDefault();
      e.stopPropagation();
      openMoveSubmenu();
    }
  }, [openMoveSubmenu]);

  const handleSubmenuKeyDownCapture = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMoveSubmenu();
    }
  }, [closeMoveSubmenu]);

  if (!tab) return null;

  return (
    <>
      <Combobox
        open={open}
        onOpenChange={handleOpenChange}
        items={items}
        itemToStringLabel={itemToStringLabel}
        autoHighlight="always"
        onValueChange={(value) => {
          if (value === "move") {
            openMoveSubmenu();
            return;
          }
          if (value) {
            onAction(value as string);
            onOpenChange(false);
          }
        }}
      >
        {/* Trigger lives inside the Combobox so base-ui owns the
            toggle-vs-outside-press behavior — clicking it while open closes
            cleanly instead of close-then-reopen flashing (same as the model
            picker). Rendered chevron-free via the base-ui primitive. */}
        <ComboboxPrimitive.Trigger className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted transition-colors">
          Actions
          <Kbd>⌘K</Kbd>
        </ComboboxPrimitive.Trigger>
        <ComboboxContent
          side="top"
          align="end"
          sideOffset={8}
          className="w-auto min-w-44"
          onKeyDownCapture={handleKeyDownCapture}
        >
          <div className="px-2 py-1.5 text-xs text-muted-foreground truncate border-b border-border">
            {tab.title}
          </div>
          <ComboboxList>
            <ComboboxCollection>
              {(id: string) => {
                const action = actionsById.get(id);
                if (!action) return null;
                const Icon = ICONS[id];
                if (id === "move") {
                  return (
                    <ComboboxPrimitive.Item
                      key={id}
                      value={id}
                      data-slot="combobox-item"
                      ref={moveItemRef}
                      className="relative flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-2 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
                    >
                      {Icon && <Icon className="size-3.5" />}
                      <span className="flex-1">{action.label}</span>
                      <ChevronRight className="size-3.5 text-muted-foreground" />
                    </ComboboxPrimitive.Item>
                  );
                }
                return (
                  <ComboboxPrimitive.Item
                    key={id}
                    value={id}
                    data-slot="combobox-item"
                    className="relative flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-2 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
                  >
                    {Icon && <Icon className="size-3.5" />}
                    <span>{action.label}</span>
                  </ComboboxPrimitive.Item>
                );
              }}
            </ComboboxCollection>
          </ComboboxList>
          <ComboboxInput placeholder="Search actions..." showTrigger={false} />
        </ComboboxContent>
      </Combobox>
      {moveOpen && (
        <Combobox
          open
          onOpenChange={(next) => { if (!next) closeMoveSubmenu(); }}
          items={spaceItems}
          itemToStringLabel={spaceToStringLabel}
          autoHighlight="always"
          onValueChange={(value) => {
            if (value) {
              onAction(`move:${value}`);
              setMoveOpen(false);
              onOpenChange(false);
            }
          }}
        >
          <ComboboxContent side="right" align="start" sideOffset={4} anchor={moveItemRef} className="w-auto min-w-40" onKeyDownCapture={handleSubmenuKeyDownCapture}>
            <ComboboxList>
              <ComboboxCollection>
                {(id: string) => {
                  const space = spacesById.get(id);
                  if (!space) return null;
                  return (
                    <ComboboxItem key={id} value={id} className="gap-2">
                      <span className="size-4 flex items-center justify-center text-xs">
                        {space.icon || space.name.charAt(0)}
                      </span>
                      <span>{space.name}</span>
                    </ComboboxItem>
                  );
                }}
              </ComboboxCollection>
            </ComboboxList>
            <ComboboxInput placeholder="Search spaces..." showTrigger={false} autoFocus />
          </ComboboxContent>
        </Combobox>
      )}
    </>
  );
}
