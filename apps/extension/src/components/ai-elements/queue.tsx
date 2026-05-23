// Adapted from Vercel's `ai-elements/queue` component
// (https://ai-sdk.dev/elements/components/queue).
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ChevronDownIcon, PaperclipIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type QueueMessagePart = {
  type: string;
  text?: string;
  url?: string;
  filename?: string;
  mediaType?: string;
};

export type QueueMessage = {
  id: string;
  parts: QueueMessagePart[];
};

export type QueueTodo = {
  id: string;
  title: string;
  description?: string;
  status?: "pending" | "completed";
};

export type QueueItemProps = ComponentProps<"li">;

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li
    className={cn(
      "group flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-muted",
      className,
    )}
    {...props}
  />
);

export type QueueItemIndicatorProps = ComponentProps<"span"> & {
  completed?: boolean;
};

export const QueueItemIndicator = ({
  completed = false,
  className,
  ...props
}: QueueItemIndicatorProps) => (
  <span
    className={cn(
      "inline-block size-2 shrink-0 rounded-full border",
      completed
        ? "border-muted-foreground/20 bg-muted-foreground/10"
        : "border-muted-foreground/50",
      className,
    )}
    {...props}
  />
);

export type QueueItemContentProps = ComponentProps<"span"> & {
  completed?: boolean;
};

export const QueueItemContent = ({
  completed = false,
  className,
  ...props
}: QueueItemContentProps) => (
  <span
    className={cn(
      "line-clamp-1 grow break-words text-xs",
      completed
        ? "text-muted-foreground/50 line-through"
        : "text-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemDescriptionProps = ComponentProps<"div"> & {
  completed?: boolean;
};

export const QueueItemDescription = ({
  completed = false,
  className,
  ...props
}: QueueItemDescriptionProps) => (
  <div
    className={cn(
      "ml-6 text-xs",
      completed
        ? "text-muted-foreground/40 line-through"
        : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemActionsProps = ComponentProps<"div">;

export const QueueItemActions = ({
  className,
  ...props
}: QueueItemActionsProps) => (
  <div className={cn("flex shrink-0 gap-0.5", className)} {...props} />
);

export type QueueItemActionProps = Omit<
  ComponentProps<typeof Button>,
  "variant" | "size"
>;

export const QueueItemAction = ({
  className,
  ...props
}: QueueItemActionProps) => (
  <Button
    className={cn(
      "size-6 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/10 hover:text-foreground group-hover:opacity-100",
      className,
    )}
    size="icon"
    type="button"
    variant="ghost"
    {...props}
  />
);

export type QueueItemAttachmentProps = ComponentProps<"div">;

export const QueueItemAttachment = ({
  className,
  ...props
}: QueueItemAttachmentProps) => (
  // No `mt-*`: the upstream ai-elements/queue assumed a column layout
  // (text stacked above attachments) where a top margin separated the
  // two rows. Our QueueItem is row-flex with `items-center`, so any
  // top margin on a flex child offsets it from the row's centerline
  // and pushes thumbnails visibly below the action buttons.
  <div className={cn("flex flex-wrap gap-1", className)} {...props} />
);

export type QueueItemImageProps = ComponentProps<"img">;

export const QueueItemImage = ({
  className,
  ...props
}: QueueItemImageProps) => (
  <img
    alt=""
    className={cn("size-6 rounded border object-cover", className)}
    height={24}
    width={24}
    {...props}
  />
);

export type QueueItemFileProps = ComponentProps<"span">;

export const QueueItemFile = ({
  children,
  className,
  ...props
}: QueueItemFileProps) => (
  <span
    className={cn(
      "flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 text-xs",
      className,
    )}
    {...props}
  >
    <PaperclipIcon size={10} />
    <span className="max-w-[100px] truncate">{children}</span>
  </span>
);

export type QueueListProps = ComponentProps<typeof ScrollArea>;

export const QueueList = ({
  children,
  className,
  ...props
}: QueueListProps) => (
  // No `-mb-1`: the parent QueueSectionContent uses `overflow-hidden`
  // (for the collapse animation), and a negative bottom margin on the
  // ScrollArea reduces the parent's effective content height by 4px.
  // That clipped the bottom 4px of the LAST queued item, including its
  // hover background — the children sat at y=4..28 inside a 32px LI,
  // but only y=0..28 was visible, so the hover bg looked like it had
  // 4px of breathing room on top and 0px on the bottom.
  <ScrollArea className={cn("mt-1", className)} {...props}>
    {/* No right padding: in this compact panel the queue rarely
        scrolls, and the original `pr-4` (carried over from the
        upstream ai-elements/queue) left a conspicuous empty gutter
        on the right of every row. */}
    <div className="max-h-40">
      <ul className="space-y-0.5">{children}</ul>
    </div>
  </ScrollArea>
);

export type QueueSectionProps = ComponentProps<typeof Collapsible>;

export const QueueSection = ({
  className,
  defaultOpen = true,
  ...props
}: QueueSectionProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type QueueSectionTriggerProps = ComponentProps<"button">;

export const QueueSectionTrigger = ({
  children,
  className,
  ...props
}: QueueSectionTriggerProps) => (
  <CollapsibleTrigger asChild>
    <button
      className={cn(
        "group flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  </CollapsibleTrigger>
);

export type QueueSectionLabelProps = ComponentProps<"span"> & {
  count?: number;
  label: string;
  icon?: React.ReactNode;
};

export const QueueSectionLabel = ({
  count,
  label,
  icon,
  className,
  ...props
}: QueueSectionLabelProps) => (
  <span className={cn("flex items-center gap-1.5", className)} {...props}>
    <ChevronDownIcon className="group-data-[state=closed]:-rotate-90 size-3 transition-transform" />
    {icon}
    <span>
      {count} {label}
    </span>
  </span>
);

export type QueueSectionContentProps = ComponentProps<typeof CollapsibleContent>;

export const QueueSectionContent = ({
  className,
  ...props
}: QueueSectionContentProps) => (
  // The `overflow-hidden` + `animate-collapsible-{up,down}` recipe is
  // the same one used by chain-of-thought, task, ToolCallBlock, etc.
  // Driven by Radix's `--radix-collapsible-content-height` CSS var,
  // which the Tailwind keyframes resolve in `app.css`.
  <CollapsibleContent
    className={cn(
      "overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
      className,
    )}
    {...props}
  />
);

export type QueueProps = ComponentProps<"div">;

export const Queue = ({ className, ...props }: QueueProps) => (
  <div
    className={cn(
      "flex flex-col gap-1 rounded-md border border-border bg-background/50 px-1.5 py-1.5",
      className,
    )}
    {...props}
  />
);
