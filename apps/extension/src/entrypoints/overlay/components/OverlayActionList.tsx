import { Kbd } from "@/components/ui/kbd";
import type { Space } from "@/lib/types";
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
import {
  AppWindowMacIcon,
  BrushCleaningIcon,
  Clock,
  GripVertical,
  Layers,
  Maximize2,
  MessageCircle,
  Palette,
  Settings,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef } from "react";

export interface ActionItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  type: "action" | "space";
}

interface OverlayActionListProps {
  actionQuery: string;
  spaces: Space[];
  activeSpaceId: string | null;
  focusIndex: number;
  isTidying: boolean;
  tidyProgress: string;
  onFocusIndex: (i: number) => void;
  onAction: (actionId: string) => void;
  onSwitchSpace: (spaceId: string) => void;
  onReorderSpaces: (spaces: Space[]) => void;
}

const ACTIONS: ActionItem[] = [
  { id: "tidy", label: "Tidy tabs", icon: Sparkles, type: "action" },
  {
    id: "clean",
    label: "Clean (close tabs)",
    icon: BrushCleaningIcon,
    type: "action",
  },
  { id: "chat", label: "AI chat", icon: MessageCircle, type: "action" },
  { id: "history", label: "History", icon: Clock, type: "action" },
  {
    id: "new-space",
    label: "New space",
    icon: AppWindowMacIcon,
    type: "action",
  },
  {
    id: "configure-space",
    label: "Configure space",
    icon: Palette,
    type: "action",
  },
  { id: "full-view", label: "Open full view", icon: Maximize2, type: "action" },
  { id: "settings", label: "Settings", icon: Settings, type: "action" },
];

function matchesQuery(label: string, query: string): boolean {
  if (!query) return true;
  return label.toLowerCase().includes(query.toLowerCase());
}

export function useFilteredActions(
  actionQuery: string,
  spaces: Space[],
): ActionItem[] {
  const filteredActions = ACTIONS.filter((a) =>
    matchesQuery(a.label, actionQuery),
  );
  const filteredSpaces = spaces
    .filter((s) => matchesQuery(s.name, actionQuery))
    .map(
      (s): ActionItem => ({
        id: `space-${s.id}`,
        label: s.name,
        icon: Layers,
        type: "space",
      }),
    );
  return [...filteredActions, ...filteredSpaces];
}

interface SortableSpaceItemProps {
  space: Space;
  isActive: boolean;
  isFocused: boolean;
  idx: number;
  onMouseEnter: () => void;
  onClick: () => void;
  isDragDisabled: boolean;
}

function SortableSpaceItem({
  space,
  isActive,
  isFocused,
  idx,
  onMouseEnter,
  onClick,
  isDragDisabled,
}: SortableSpaceItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: space.id, disabled: isDragDisabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors group ${
        isFocused
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-muted"
      }`}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      {!isDragDisabled && (
        <span
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <GripVertical className="size-3.5" />
        </span>
      )}
      <Layers className="size-4 shrink-0" />
      <span className="flex-1 truncate">
        {space.icon && <span className="mr-1.5">{space.icon}</span>}
        {space.name}
      </span>
      {isActive && (
        <span className="size-1.5 rounded-full bg-foreground/50 shrink-0" />
      )}
      {space.position <= 9 && <Kbd>⌥{space.position}</Kbd>}
    </button>
  );
}

export function OverlayActionList({
  actionQuery,
  spaces,
  activeSpaceId,
  focusIndex,
  isTidying,
  tidyProgress,
  onFocusIndex,
  onAction,
  onSwitchSpace,
  onReorderSpaces,
}: OverlayActionListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const items = useFilteredActions(actionQuery, spaces);
  const isDragDisabled = actionQuery.trim().length > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
  );

  useEffect(() => {
    const el = listRef.current?.children[0]?.children[focusIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [focusIndex]);

  const handleSelect = (item: ActionItem) => {
    if (item.id === "tidy" && isTidying) return;
    if (item.type === "space") {
      onSwitchSpace(item.id.replace("space-", ""));
    } else {
      onAction(item.id);
    }
  };

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const sortedSpaces = [...spaces].sort((a, b) => a.position - b.position);
    const oldIndex = sortedSpaces.findIndex((s) => s.id === active.id);
    const newIndex = sortedSpaces.findIndex((s) => s.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...sortedSpaces];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);

    const updated = reordered.map((s, i) => ({ ...s, position: i + 1 }));
    onReorderSpaces(updated);
  }

  if (items.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-sm text-muted-foreground">
        No matching actions.
      </div>
    );
  }

  const actionItems = items.filter((i) => i.type === "action");
  const spaceItems = items.filter((i) => i.type === "space");
  const sortedFilteredSpaces = spaces
    .filter((s) => spaceItems.some((si) => si.id === `space-${s.id}`))
    .sort((a, b) => a.position - b.position);
  let globalIndex = 0;

  return (
    <div
      ref={listRef}
      className="max-h-72 overflow-y-auto overflow-x-hidden py-1"
    >
      <div>
        {actionItems.length > 0 && (
          <div className="px-3 py-1 text-xs font-medium text-muted-foreground">
            Actions
          </div>
        )}
        {actionItems.map((item) => {
          const idx = globalIndex++;
          const Icon = item.icon;
          const disabled = item.id === "tidy" && isTidying;
          const label =
            item.id === "tidy" && isTidying
              ? `Tidying ${tidyProgress}`
              : item.label;
          return (
            <button
              key={item.id}
              disabled={disabled}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                disabled
                  ? "text-muted-foreground cursor-default"
                  : idx === focusIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-muted"
              }`}
              onMouseEnter={() => !disabled && onFocusIndex(idx)}
              onClick={() => handleSelect(item)}
            >
              <Icon
                className={`size-4 shrink-0 ${disabled ? "animate-pulse" : ""}`}
              />
              <span className="flex-1 truncate">{label}</span>
              {item.id === "chat" && <Kbd>⌥I</Kbd>}
              {item.id === "settings" && <Kbd>⌥,</Kbd>}
            </button>
          );
        })}
        {spaceItems.length > 0 && actionItems.length > 0 && (
          <div className="my-1 h-px bg-border" />
        )}
        {spaceItems.length > 0 && (
          <div className="px-3 py-1 text-xs font-medium text-muted-foreground">
            Spaces
          </div>
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sortedFilteredSpaces.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            {sortedFilteredSpaces.map((space) => {
              const idx = globalIndex++;
              return (
                <SortableSpaceItem
                  key={space.id}
                  space={space}
                  isActive={space.id === activeSpaceId}
                  isFocused={idx === focusIndex}
                  idx={idx}
                  onMouseEnter={() => onFocusIndex(idx)}
                  onClick={() => onSwitchSpace(space.id)}
                  isDragDisabled={isDragDisabled}
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
