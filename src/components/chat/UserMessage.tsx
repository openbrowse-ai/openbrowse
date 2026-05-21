import type { AgentUIMessage } from "@/lib/types";
import { Check, Copy, Pencil } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ReadOnlyEditor } from "@/components/tiptap/ReadOnlyEditor";
import { ZoomableImage } from "@/components/ui/zoomable-image";

interface UserMessageProps {
  message: AgentUIMessage;
  onEdit?: () => void;
  dimmed?: boolean;
}

export function UserMessage({ message, onEdit, dimmed }: UserMessageProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const rawText = message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");

  const text = useMemo(
    () => rawText.split("\n\n-----\n\n<Mentioned tabs>")[0],
    [rawText],
  );

  const imageUrls = useMemo(
    () =>
      message.parts
        .filter((p) => p.type === "file" && p.mediaType.startsWith("image/"))
        .map((p) => (p as { url: string }).url),
    [message.parts],
  );

  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  }, [text]);

  return (
    <div className={`group/message flex flex-col items-end gap-1 ${dimmed ? "opacity-40" : ""}`}>
      {imageUrls.length > 0 && (
        <div className="max-w-[85%] flex flex-wrap justify-end gap-1">
          {imageUrls.map((url, i) => (
            <ZoomableImage
              key={i}
              src={url}
              alt="Attached image"
              className="max-w-[200px] max-h-[200px] object-cover rounded-lg"
            />
          ))}
        </div>
      )}
      {text && (
        <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-primary text-primary-foreground break-words">
          <ReadOnlyEditor
            content={text}
            className="prose-invert [&>p]:!my-0 [&_.tab-mention]:bg-primary-foreground/20"
          />
        </div>
      )}
      {!dimmed && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover/message:opacity-100 transition-opacity">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCopy}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{copied ? "Copied!" : "Copy"}</TooltipContent>
          </Tooltip>
          {onEdit && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onEdit}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Edit</TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}
