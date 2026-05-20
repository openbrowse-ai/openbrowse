import { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function BrowserChrome({ children, className, url = "https://example.com" }: { children: ReactNode, className?: string, url?: string }) {
  return (
    <div className={cn("flex flex-col w-full h-full", className)}>
      {/* Chrome header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="size-3 rounded-full bg-red-500/80" />
          <div className="size-3 rounded-full bg-yellow-500/80" />
          <div className="size-3 rounded-full bg-green-500/80" />
        </div>
        <div className="mx-4 flex-1 max-w-sm rounded-md bg-background px-3 py-1 text-xs text-muted-foreground border flex items-center justify-center truncate">
          {url}
        </div>
        <div className="w-8 shrink-0" /> {/* Balance for centering */}
      </div>
      {/* Chrome body */}
      <div className="flex-1 relative bg-background overflow-hidden">
        {children}
      </div>
    </div>
  );
}
