import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect } from "react";
import { getToolPreview } from "./tool-previews";
import { DefaultPreview } from "./tool-previews/primitives";
import { TabBadge } from "./ToolCallBlock";

interface ToolApprovalBlockProps {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  approvalId: string;
  siteOrigin?: string;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAlwaysAllow?: (toolName: string, origin: string) => void;
}

export function ToolApprovalBlock({ toolName, toolCallId, args, approvalId, siteOrigin, onApprove, onDeny, onAlwaysAllow }: ToolApprovalBlockProps) {
  const customPreview = getToolPreview(toolName);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onApprove(approvalId);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [approvalId, onApprove]);

  const displayOrigin = siteOrigin ? new URL(siteOrigin).hostname : undefined;

  return (
    <div className="flex flex-col w-full">
      <div className="flex items-center gap-1.5 py-0.5">
        <span className="size-1.5 rounded-full shrink-0 bg-amber-500 animate-pulse" />
        <span className="text-sm text-muted-foreground">
          {toolName} — waiting for approval
        </span>
        <TabBadge toolCallId={toolCallId} />
      </div>
      <div className="ml-3 mt-1 mb-1 rounded-md border border-amber-500/30 overflow-hidden text-xs font-mono">
        {customPreview ? customPreview(args) : <DefaultPreview args={args} />}
        <div className="flex flex-col gap-2 px-3 py-2 border-t border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onDeny(approvalId)}
              className="flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <X className="size-3.5 shrink-0" />
              Deny
            </button>
            <button
              type="button"
              onClick={() => onApprove(approvalId)}
              className="flex items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1.5 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
            >
              <Check className="size-3.5 shrink-0" />
              Allow
              <kbd className="ml-0.5 inline-flex items-center gap-0.5 rounded border border-white/20 bg-white/10 px-1 py-0.5 text-[10px] font-sans leading-none">
                <span>&#8984;</span><span>&#9166;</span>
              </kbd>
            </button>
          </div>
          {displayOrigin && onAlwaysAllow && (
            <button
              type="button"
              onClick={() => {
                onAlwaysAllow(toolName, siteOrigin!);
                onApprove(approvalId);
              }}
              className="flex items-center justify-center gap-1.5 w-full rounded px-2.5 py-1.5 text-xs font-medium bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <ShieldCheck className="size-3.5 shrink-0" />
              Always allow on {displayOrigin}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
