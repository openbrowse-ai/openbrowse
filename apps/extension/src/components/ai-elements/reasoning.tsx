import { Markdown } from "@/components/chat/Markdown";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ReasoningProps {
  text: string;
  isStreaming?: boolean;
  className?: string;
}

export function Reasoning({
  text,
  isStreaming = false,
  className,
}: ReasoningProps) {
  const [open, setOpen] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (isStreaming) {
      startTimeRef.current = Date.now();
      setDurationSeconds(null);
      setOpen(true);
    } else if (startTimeRef.current !== null) {
      const elapsed = Math.round((Date.now() - startTimeRef.current) / 1000);
      setDurationSeconds(elapsed);
      startTimeRef.current = null;
      setOpen(false);
    }
  }, [isStreaming]);

  // Anthropic's adaptive-thinking models (Opus 4.7+) emit thinking blocks
  // whose text is empty unless the request asks for
  // `thinking: { type: "adaptive", display: "summarized" }`. We only ask for
  // that when the composer's Thinking toggle is on (see
  // `buildThinkingProviderOptions`), so with the toggle off the stream still
  // carries reasoning parts — just with no content. Rendering the collapsible
  // for one of those gives a "Reasoning" header that expands to nothing.
  //
  // Drop the block once it has settled. While it is still streaming the
  // header stays (it's a useful liveness cue, and text may simply not have
  // arrived yet).
  const isEmpty = text.trim().length === 0;

  const label = isStreaming
    ? "Thinking..."
    : durationSeconds != null && durationSeconds > 0
      ? `Thought for ${durationSeconds}s`
      : "Reasoning";

  if (isEmpty && !isStreaming) return null;

  return (
    <div className={cn("w-full", className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <BrainIcon className="size-3 shrink-0" />
        <span className={cn("font-medium", isStreaming && "animate-pulse")}>
          {label}
        </span>
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="ml-3 mt-1 border-l border-muted pl-3 pb-1">
          <Markdown
            source={text}
            className="text-xs [&_*]:text-xs text-muted-foreground"
            isStreaming={isStreaming}
          />
        </div>
      )}
    </div>
  );
}
