import { Globe } from "lucide-react";

interface Props {
  result: unknown;
}

export function SnapshotResult({ result }: Props) {
  const obj = result as { snapshot?: string; refCount?: number; url?: string } | undefined;
  if (!obj?.snapshot) return null;

  const lines = obj.snapshot.split("\n");
  const truncated = lines.length > 40;
  const displayLines = truncated ? lines.slice(0, 40) : lines;

  return (
    <div className="ml-3 mt-1 mb-1 rounded-md border border-border overflow-hidden text-xs font-mono">
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-muted/50 border-b border-border text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Globe className="size-3" />
          <span className="truncate max-w-[200px]">{obj.url ?? "Page"}</span>
        </div>
        <span className="text-[10px] opacity-70">{obj.refCount} refs</span>
      </div>
      <div className="px-3 py-2 bg-background/50 overflow-x-auto max-h-64 overflow-y-auto styled-scrollbar">
        <pre className="whitespace-pre text-foreground/80">
          {displayLines.join("\n")}{truncated ? "\n  …" : ""}
        </pre>
      </div>
    </div>
  );
}
