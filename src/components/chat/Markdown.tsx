import { cn } from "@/lib/utils";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

interface MarkdownProps {
  source: string;
  className?: string;
  isStreaming?: boolean;
}

export function Markdown({ source, className, isStreaming = false }: MarkdownProps) {
  return (
    <Streamdown
      className={cn(
        "prose prose-sm dark:prose-invert prose-p:text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-li:text-foreground max-w-none",
        className,
      )}
      animated
      isAnimating={isStreaming}
      caret={isStreaming ? "circle" : undefined}
    >
      {source}
    </Streamdown>
  );
}
