import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentUIMessage } from "@/lib/types";
import { formatMessageAsMarkdown } from "@/lib/format-markdown";
import { Check, Copy } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

interface MessageActionsProps {
  message: AgentUIMessage;
}

export function MessageActions({ message }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const textContent = useMemo(() => {
    return formatMessageAsMarkdown(message);
  }, [message.parts]);

  const handleCopy = useCallback(async () => {
    if (!textContent) return;
    try {
      await navigator.clipboard.writeText(textContent);
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  }, [textContent]);

  if (!textContent) return null;

  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover/message:opacity-100 transition-opacity">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopy}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {copied ? (
              <Check className="size-3" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {copied ? "Copied!" : "Copy"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
