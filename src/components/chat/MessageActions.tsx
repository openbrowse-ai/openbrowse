import type { UIMessage } from "@ai-sdk/react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface MessageActionsProps {
  message: UIMessage;
  onRegenerate?: () => void;
}

export function MessageActions({ message, onRegenerate }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const textContent = useMemo(() => {
    return message.parts
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "dynamic-tool" || (typeof part.type === "string" && part.type.startsWith("tool-") && "toolCallId" in part && "input" in part)) {
          const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
          const p = part as Record<string, unknown>;
          const input = p.input as Record<string, unknown> | undefined;
          const hasOutput = p.state === "output-available" && "output" in p;
          const output = hasOutput ? p.output : undefined;

          if (toolName === "screenshot") {
            return `**Tool: screenshot**\n[Screenshot captured — base64 image data redacted]`;
          }

          if (toolName === "executeCode" || toolName === "executeOnPage") {
            const code = typeof input?.code === "string" ? input.code : "";
            const lines = [`**Tool: ${toolName}**`, "```javascript", code, "```"];
            if (hasOutput) {
              const out = output as { result?: unknown; logs?: string[]; error?: string } | undefined;
              if (out?.error) {
                lines.push(`Error: ${out.error}`);
              } else if (out?.result !== undefined) {
                lines.push(`Result: ${typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2)}`);
              }
              if (out?.logs && out.logs.length > 0) {
                lines.push(`Logs:\n${out.logs.join("\n")}`);
              }
            }
            return lines.join("\n");
          }

          const header = `**Tool: ${toolName}**`;
          const inputStr = input ? `Input: ${JSON.stringify(input, null, 2)}` : "";
          const outputStr = hasOutput ? `Output: ${JSON.stringify(output, null, 2)}` : "";
          return [header, inputStr, outputStr].filter(Boolean).join("\n");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim();
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

  if (!textContent && !onRegenerate) return null;

  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover/message:opacity-100 transition-opacity">
      {textContent && (
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
      )}
      {onRegenerate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onRegenerate}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Regenerate</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
