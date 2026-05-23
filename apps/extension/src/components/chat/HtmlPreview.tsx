import { cn } from "@/lib/utils";
import { CodeViewer } from "@/components/chat/CodeViewer";

export type HtmlPreviewMode = "preview" | "source";

interface HtmlPreviewProps {
  text: string;
  fileName: string;
  mode: HtmlPreviewMode;
  className?: string;
}

/**
 * Renders an HTML file in a sandboxed iframe by default, or its raw source
 * via the existing CodeViewer.
 *
 * Sandbox: empty `sandbox=""` denies scripts, same-origin, popups, forms,
 * pointer-lock, and top-navigation. The agent writes HTML for reports/plots;
 * we surface them readable but inert. If users need scripts, they can open
 * the file in a real tab via Download.
 *
 * Mode is controlled — toolbar lives in the parent `FileViewerPanel`.
 */
export function HtmlPreview({ text, fileName, mode, className }: HtmlPreviewProps) {
  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
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
            className="w-full h-full border-0 bg-white"
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
