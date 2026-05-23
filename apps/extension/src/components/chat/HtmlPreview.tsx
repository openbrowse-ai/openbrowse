import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CodeViewer } from "@/components/chat/CodeViewer";

interface HtmlPreviewProps {
  text: string;
  fileName: string;
  className?: string;
}

type ViewMode = "preview" | "source";

/**
 * Renders an HTML file in a sandboxed iframe by default, or its raw source
 * via the existing CodeViewer.
 *
 * Sandbox: empty `sandbox=""` denies scripts, same-origin, popups, forms,
 * pointer-lock, and top-navigation. The agent writes HTML for reports/plots;
 * we surface them readable but inert. If users need scripts, they can open
 * the file in a real tab via Download.
 */
export function HtmlPreview({ text, fileName, className }: HtmlPreviewProps) {
  const [mode, setMode] = useState<ViewMode>("preview");

  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border bg-muted/20 shrink-0">
        <div className="text-xs text-muted-foreground font-mono truncate min-w-0">
          {mode === "preview" && (
            <span title="Scripts and same-origin access are blocked">
              Sandboxed preview
            </span>
          )}
          {mode === "source" && <span>Source</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant={mode === "preview" ? "secondary" : "ghost"}
            onClick={() => setMode("preview")}
            className="h-6 px-2 text-xs"
          >
            Preview
          </Button>
          <Button
            size="sm"
            variant={mode === "source" ? "secondary" : "ghost"}
            onClick={() => setMode("source")}
            className="h-6 px-2 text-xs"
          >
            Source
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-background">
        {mode === "preview" ? (
          <iframe
            // `sandbox=""` (empty value) is the strictest setting — denies
            // scripts, same-origin, forms, popups. Using the boolean form
            // would do the same, but explicit empty string makes intent obvious.
            sandbox=""
            srcDoc={text}
            title={fileName}
            referrerPolicy="no-referrer"
            className="w-full h-[75vh] border-0 bg-white"
          />
        ) : (
          <CodeViewer
            code={text}
            language="html"
            className="text-sm leading-relaxed [&_pre]:!m-0 [&_pre]:p-4 [&_pre]:overflow-auto [&_code]:font-mono"
          />
        )}
      </div>
    </div>
  );
}
