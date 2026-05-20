import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SceneFrame({ children, className }: { children: ReactNode, className?: string }) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-lg border bg-background shadow-sm", className)}
    >
      {children}
    </div>
  );
}
