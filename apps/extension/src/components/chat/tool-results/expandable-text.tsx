import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface ExpandableTextProps {
  text: string;
  maxLines?: number;
  className?: string;
}

export function ExpandableText({ text, maxLines = 10, className }: ExpandableTextProps) {
  const [expanded, setExpanded] = useState(false);
  
  if (!text) return null;

  const lines = text.split("\n");
  const isExpandable = lines.length > maxLines;
  const displayText = (!isExpandable || expanded) ? text : lines.slice(0, maxLines).join("\n");

  return (
    <div className="relative group">
      <pre className={cn("whitespace-pre-wrap", className)}>
        {displayText}
      </pre>
      {isExpandable && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground text-[10px] mt-1.5 flex items-center gap-1 font-sans transition-colors cursor-pointer select-none"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="size-3" /> Show {lines.length - maxLines} more lines
            </>
          )}
        </button>
      )}
    </div>
  );
}
