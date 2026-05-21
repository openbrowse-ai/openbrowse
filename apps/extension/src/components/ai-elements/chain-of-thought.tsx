"use client";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cva } from "class-variance-authority";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

const ChainOfThought = CollapsiblePrimitive.Root;

const ChainOfThoughtHeader = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.Trigger
    ref={ref}
    className={cn(
      "group flex items-center gap-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground",
      className
    )}
    {...props}
  >
    <ChevronRightIcon className="h-3 w-3 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90" />
    <span className="font-medium">{children}</span>
  </CollapsiblePrimitive.Trigger>
));
ChainOfThoughtHeader.displayName = "ChainOfThoughtHeader";

const ChainOfThoughtContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.Content
    ref={ref}
    className={cn(
      "overflow-hidden transition-all data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down ml-[5px] border-l pl-4 pb-2 mt-1",
      className
    )}
    {...props}
  >
    <div className="flex flex-col gap-3 pt-1">{children}</div>
  </CollapsiblePrimitive.Content>
));
ChainOfThoughtContent.displayName = "ChainOfThoughtContent";

const stepVariants = cva("flex items-start gap-2.5 text-xs", {
  variants: {
    status: {
      pending: "text-muted-foreground/70",
      active: "text-foreground font-medium",
      complete: "text-muted-foreground",
      cancelled: "text-muted-foreground/50 line-through",
    },
  },
  defaultVariants: {
    status: "pending",
  },
});

interface ChainOfThoughtStepProps extends React.HTMLAttributes<HTMLDivElement> {
  status?: "pending" | "active" | "complete" | "cancelled";
  label: string;
}

const ChainOfThoughtStep = React.forwardRef<
  HTMLDivElement,
  ChainOfThoughtStepProps
>(({ className, status = "pending", label, children, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(stepVariants({ status }), className)}
      {...props}
    >
      <div className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center bg-background">
        {status === "pending" && <CircleIcon className="h-2 w-2" />}
        {status === "active" && (
          <Loader2Icon className="h-3 w-3 text-blue-500 animate-spin" />
        )}
        {status === "complete" && <CheckIcon className="h-3 w-3" />}
        {status === "cancelled" && <XIcon className="h-3 w-3" />}
      </div>
      <div className="flex flex-col gap-1">
        <span className="leading-tight">{label}</span>
        {children && <div className="text-muted-foreground/80">{children}</div>}
      </div>
    </div>
  );
});
ChainOfThoughtStep.displayName = "ChainOfThoughtStep";

export {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
};