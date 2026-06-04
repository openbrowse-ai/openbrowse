import type { AgentUIMessage } from "@/lib/types";
import { ReadOnlyEditor } from "@/components/tiptap/ReadOnlyEditor";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ZoomableImage } from "@/components/ui/zoomable-image";
import { Check, Copy, Pencil } from "lucide-react";
import { useCallback, useMemo, useRef, useState, memo } from "react";
import { parseAttachedFiles } from "@/lib/chat/parse-attached-files";
import { classifyFile } from "@/lib/vfs/file-classify";
import { getTypeBadge } from "@/lib/chat/attachment-meta";
import { useFileSelection } from "@/lib/file-selection-context";

interface UserMessageProps {
  message: AgentUIMessage;
  onEdit?: () => void;
  dimmed?: boolean;
}

function UserMessageImpl({ message, onEdit, dimmed }: UserMessageProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onSelectFile = useFileSelection();

  const rawText = message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");

  const { displayText, attachedPaths } = useMemo(() => {
    // Parse the trailing <Attached files> block FIRST (it uses
    // lastIndexOf and finds the block whether or not a <Mentioned tabs>
    // block precedes it). LandingPage persists mentions BEFORE
    // attachments, so a "split mentions then parse attachments" order
    // would discard the attachment block on those messages. After
    // parsing, strip any preceding <Mentioned tabs> block from the
    // remaining displayText.
    const { displayText: afterAttachments, attachedPaths } =
      parseAttachedFiles(rawText);
    const displayText = afterAttachments.split(
      "\n\n-----\n\n<Mentioned tabs>",
    )[0];
    return { displayText, attachedPaths };
  }, [rawText]);

  const text = displayText;

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
    <div
      className={`group/message flex flex-col items-end gap-1 ${dimmed ? "opacity-40" : ""}`}
    >
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
      {attachedPaths.length > 0 && (
        <div className="max-w-[85%] flex flex-wrap justify-end gap-1.5">
          {attachedPaths
            // Image attachments already render as thumbnails above —
            // skip them in the chip row to avoid duplication.
            .filter((path) => {
              const name = path.split("/").pop() ?? path;
              return classifyFile(name) !== "image";
            })
            .map((path) => {
              const name = path.split("/").pop() ?? path;
              // `attachedPaths` carry a leading slash; the file viewer
              // expects a workspace-relative path with no leading slash.
              const rel = path.replace(/^\//, "");
              const clickable = onSelectFile != null;
              return (
                <button
                  key={path}
                  type="button"
                  disabled={!clickable}
                  onClick={
                    clickable ? () => onSelectFile(rel) : undefined
                  }
                  aria-label={clickable ? `Open ${name}` : name}
                  className={`flex h-[108px] w-[140px] flex-col gap-1 rounded-lg border border-border bg-background p-2.5 text-left transition-colors ${
                    clickable
                      ? "cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      : "cursor-default"
                  }`}
                >
                  <div className="line-clamp-3 break-words text-xs font-medium leading-tight text-foreground">
                    {name}
                  </div>
                  <div className="mt-auto">
                    <span className="inline-block rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                      {getTypeBadge(name)}
                    </span>
                  </div>
                </button>
              );
            })}
        </div>
      )}
      {text && (
        <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-secondary text-secondary-foreground break-words">
          <ReadOnlyEditor
            content={text}
            className="text-secondary-foreground [&_*]:text-secondary-foreground [&>p]:!my-0 [&_p]:!my-0 [&_.tab-mention]:bg-foreground/10 [&_.skill-slash]:bg-foreground/10"
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

export const UserMessage = memo(UserMessageImpl);
