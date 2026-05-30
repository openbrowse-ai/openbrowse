import { cn } from "@/lib/utils";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import "./markdown.css";
import { codePlugin } from "./shiki-streamdown-plugin";

// Disable per-word stagger to work around streamdown#482: the shared stagger
// counter resets per block, so new sections animate concurrently with earlier
// still-animating ones ("slow"/"parallel" reveal). With stagger 0, only newly
// streamed words fade in (150ms), without overlapping prior sections.
// Module-level constant keeps a stable identity across renders.
// Revisit/remove once streamdown PR #493 ships in a published release.
const ANIMATE_OPTIONS = { stagger: 0 } as const;

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
      animated={ANIMATE_OPTIONS}
      isAnimating={isStreaming}
      caret={isStreaming ? "circle" : undefined}
      plugins={{ code: codePlugin }}
    >
      {source}
    </Streamdown>
  );
}
