import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import { Kbd } from "@/components/ui/kbd";
import { Settings } from "lucide-react";
import type { Space } from "@/lib/types";
import { useEffect, useMemo, useRef, useState } from "react";

interface SpacePickerProps {
  activeSpace: Space | null;
  spaces: Space[];
  onSwitchSpace: (spaceId: string) => void;
  onConfigureSpace?: () => void;
}

export function SpacePicker({ activeSpace, spaces, onSwitchSpace, onConfigureSpace }: SpacePickerProps) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(() => [...spaces].sort((a, b) => a.position - b.position), [spaces]);
  const items = useMemo(() => sorted.map((s) => s.id), [sorted]);
  const spacesById = useMemo(() => {
    const map = new Map<string, Space>();
    for (const s of spaces) map.set(s.id, s);
    return map;
  }, [spaces]);
  const itemToStringLabel = useMemo(
    () => (id: string) => spacesById.get(id)?.name ?? id,
    [spacesById],
  );

  const listRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open && activeSpace?.id) {
      requestAnimationFrame(() => {
        const list = listRef.current;
        if (!list) return;
        const activeItem = list.querySelector(`[data-value="${activeSpace.id}"]`) as HTMLElement | null;
        activeItem?.scrollIntoView({ block: "nearest" });
      });
    }
  }, [open, activeSpace?.id]);

  return (
    <Combobox
      open={open}
      onOpenChange={setOpen}
      items={items}
      itemToStringLabel={itemToStringLabel}
      autoHighlight="always"
      value={activeSpace?.id ?? null}
      onValueChange={(value) => {
        if (value) {
          onSwitchSpace(value as string);
          setOpen(false);
        }
      }}
    >
      <ComboboxPrimitive.Trigger
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-sm hover:bg-muted transition-colors"
        title={activeSpace?.name ?? "Spaces"}
      >
        {activeSpace?.icon || activeSpace?.name.charAt(0) || "S"}
      </ComboboxPrimitive.Trigger>
      <ComboboxContent side="bottom" align="start" sideOffset={8} className="w-auto min-w-48">
        <ComboboxInput placeholder="Search spaces..." showTrigger={false} />
        <ComboboxList ref={listRef as React.Ref<HTMLDivElement>}>
          <ComboboxCollection>
            {(id: string) => {
              const space = spacesById.get(id);
              if (!space) return null;
              return (
                <ComboboxItem key={space.id} value={space.id} className="gap-2">
                  <span className="size-4 flex items-center justify-center text-xs">
                    {space.icon || space.name.charAt(0)}
                  </span>
                  <span className="flex-1 truncate">{space.name}</span>
                  {space.id === activeSpace?.id && (
                    <span className="text-xs text-muted-foreground">active</span>
                  )}
                  {space.position <= 9 && (
                    <Kbd className="ml-auto">⌥{space.position}</Kbd>
                  )}
                </ComboboxItem>
              );
            }}
          </ComboboxCollection>
        </ComboboxList>
        {onConfigureSpace && (
          <>
            <div className="-mx-1 my-1 h-px bg-border" />
            <div className="p-1">
              <button
                onClick={() => {
                  setOpen(false);
                  onConfigureSpace();
                }}
                className="flex w-full items-center gap-2 rounded-md py-1 pl-1.5 pr-8 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                <Settings className="size-4 shrink-0" />
                <span>Configure space</span>
              </button>
            </div>
          </>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
