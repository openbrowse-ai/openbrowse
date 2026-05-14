import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Wrench } from "lucide-react";
import { storage } from "@/lib/storage";
import type { Space } from "@/lib/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function SortableSpaceRow({
  space,
  isActive,
  onConfigure,
}: {
  space: Space;
  isActive: boolean;
  onConfigure: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: space.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const colorPreview = space.colors
    ? space.colors.length === 1
      ? space.colors[0]
      : `linear-gradient(135deg, ${space.colors.join(", ")})`
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 bg-background group"
    >
      <span
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground"
      >
        <GripVertical className="size-4" />
      </span>
      <span className="flex size-7 items-center justify-center rounded-md bg-muted text-sm shrink-0">
        {space.icon ?? "🪟"}
      </span>
      <span className="flex-1 truncate text-sm font-medium">
        {space.name}
      </span>
      {isActive && (
        <span className="size-1.5 rounded-full bg-foreground/50 shrink-0" />
      )}
      {colorPreview && (
        <div
          className="size-4 shrink-0 rounded-full border border-border"
          style={{ background: colorPreview }}
        />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onConfigure}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Wrench className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Configure space</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function SpacesTab() {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [overlaySpaceId, setOverlaySpaceId] = useState<string | null>(null);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const loadSpaces = useCallback(async () => {
    const s = await storage.getSpaces();
    s.sort((a, b) => a.position - b.position);
    setSpaces(s);

    const win = await chrome.windows.getCurrent();
    const active = s.find((sp) => sp.windowId === win.id);
    setActiveSpaceId(active?.id ?? null);
  }, []);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === "OPENBROWSE_OVERLAY_CLOSE") {
        setOverlaySpaceId(null);
        setCreatingSpace(false);
        loadSpaces();
      }
      if (
        e.data?.type === "OPENBROWSE_OVERLAY_RESIZE" &&
        typeof e.data.height === "number" &&
        iframeRef.current
      ) {
        iframeRef.current.style.height = `${e.data.height}px`;
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [loadSpaces]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = spaces.findIndex((s) => s.id === active.id);
      const newIndex = spaces.findIndex((s) => s.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = [...spaces];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      const updated = reordered.map((s, i) => ({ ...s, position: i + 1 }));
      setSpaces(updated);
      await storage.setSpaces(updated);
    },
    [spaces]
  );

  const [creatingSpace, setCreatingSpace] = useState(false);

  const overlayUrl = overlaySpaceId
    ? chrome.runtime.getURL(`/overlay.html?action=configure-space&spaceId=${overlaySpaceId}`)
    : creatingSpace
      ? chrome.runtime.getURL(`/overlay.html?action=new-space`)
      : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Spaces are isolated workspaces — each one is its own browser window with its own tabs, favorites, and theme. Use them to separate contexts like work, personal, or projects.
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={spaces.map((s) => s.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-1.5">
            {spaces.map((space) => (
              <SortableSpaceRow
                key={space.id}
                space={space}
                isActive={space.id === activeSpaceId}
                onConfigure={() => setOverlaySpaceId(space.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {spaces.length === 0 && (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No spaces yet. Create one to get started.
        </p>
      )}
      <button
        onClick={() => setCreatingSpace(true)}
        className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors w-full"
      >
        <Plus className="size-4" />
        New space
      </button>

      {overlayUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-[20vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setOverlaySpaceId(null);
              setCreatingSpace(false);
              loadSpaces();
            }
          }}
        >
          <iframe
            ref={iframeRef}
            src={overlayUrl}
            className="w-[580px] max-w-[90vw] max-h-[70vh] border-none rounded-lg"
            onLoad={(e) => (e.currentTarget as HTMLIFrameElement).focus()}
          />
        </div>
      )}
    </div>
  );
}
