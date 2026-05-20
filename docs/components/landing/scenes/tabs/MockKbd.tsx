import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function MockKbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100",
        className
      )}
    >
      {children}
    </kbd>
  );
}
