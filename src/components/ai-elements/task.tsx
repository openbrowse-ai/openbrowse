"use client";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cva } from "class-variance-authority";
import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const Task = CollapsiblePrimitive.Root;

const TaskTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger> & {
    title: string;
  }
>(({ className, title, ...props }, ref) => (
  <CollapsiblePrimitive.Trigger
    ref={ref}
    className={cn(
      "group flex w-full items-center gap-2 rounded-t-lg bg-muted px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/80 data-[state=closed]:rounded-b-lg",
      className
    )}
    {...props}
  >
    <ChevronRightIcon className="h-4 w-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90" />
    <span className="flex-1 text-left">{title}</span>
  </CollapsiblePrimitive.Trigger>
));
TaskTrigger.displayName = "TaskTrigger";

const TaskContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.Content
    ref={ref}
    className={cn(
      "overflow-hidden rounded-b-lg border border-t-0 bg-background transition-all data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down",
      className
    )}
    {...props}
  >
    <div className="p-4 flex flex-col gap-3">{children}</div>
  </CollapsiblePrimitive.Content>
));
TaskContent.displayName = "TaskContent";

const taskItemVariants = cva(
  "flex items-start gap-2.5 text-sm transition-colors",
  {
    variants: {
      status: {
        pending: "text-muted-foreground",
        in_progress: "text-foreground",
        completed: "text-foreground",
        cancelled: "text-muted-foreground line-through",
      },
    },
    defaultVariants: {
      status: "pending",
    },
  }
);

interface TaskItemProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: "pending" | "in_progress" | "completed" | "cancelled";
}

const TaskItem = React.forwardRef<HTMLDivElement, TaskItemProps>(
  ({ className, status = "pending", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(taskItemVariants({ status }), className)}
        {...props}
      >
        <div className="mt-0.5 shrink-0 flex items-center justify-center">
          {status === "pending" && <CircleIcon className="h-4 w-4 text-muted-foreground" />}
          {status === "in_progress" && <Loader2Icon className="h-4 w-4 text-blue-500 animate-spin" />}
          {status === "completed" && <CheckCircle2Icon className="h-4 w-4 text-green-500" />}
          {status === "cancelled" && <XCircleIcon className="h-4 w-4 text-muted-foreground" />}
        </div>
        <div className="flex-1 leading-normal">{children}</div>
      </div>
    );
  }
);
TaskItem.displayName = "TaskItem";

export { Task, TaskContent, TaskItem, TaskTrigger };