import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { getHighlighter, ensureLanguage } from "../shiki-core";
import {
  estimateVisualLines,
  ESTIMATED_CHARS_PER_VISUAL_LINE,
} from "./expandable-text";

interface HighlightedCodeProps {
  code: string;
  /** Shiki language id (e.g. "python", "javascript"). Falls back to plain. */
  lang: string;
  /** Soft cap on visible lines when collapsed. Mirrors ExpandableText. */
  maxLines?: number;
  className?: string;
}

/**
 * Render a code string with Shiki syntax highlighting, preserving the
 * collapse/expand affordance of {@link ExpandableText}. Highlighting is
 * async: the raw text renders immediately (in a `<pre>`), then swaps to the
 * highlighted markup once Shiki's grammar + theme load. Unknown languages
 * fall back to plain text. Uses the shared dual-theme Shiki core, so the
 * `.shiki` token styles defined in home.css apply for light/dark.
 */
export function HighlightedCode({
  code,
  lang,
  maxLines = 10,
  className,
}: HighlightedCodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [html, setHtml] = useState<string | null>(null);

  const lines = code ? code.split("\n") : [];
  const visualLines = estimateVisualLines(code);
  const isExpandable = visualLines > maxLines;

  let displayText: string;
  if (!isExpandable || expanded) {
    displayText = code;
  } else if (lines.length > maxLines) {
    displayText = lines.slice(0, maxLines).join("\n");
  } else {
    displayText = code.slice(0, maxLines * ESTIMATED_CHARS_PER_VISUAL_LINE);
  }

  // Highlight the currently-visible slice. Re-runs when the slice changes
  // (expand/collapse) or the code itself changes. Best-effort: on any
  // failure we leave `html` null and the plain-text <pre> stays.
  useEffect(() => {
    let cancelled = false;
    if (!displayText) {
      setHtml(null);
      return;
    }
    (async () => {
      try {
        const highlighter = await getHighlighter();
        const ok = await ensureLanguage(highlighter, lang);
        const out = highlighter.codeToHtml(displayText, {
          lang: ok ? lang : "text",
          themes: {
            light: "github-light-default",
            dark: "github-dark-default",
          },
          defaultColor: false,
        });
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [displayText, lang]);

  if (!code) return null;

  const showMoreLabel =
    lines.length > maxLines
      ? `Show ${lines.length - maxLines} more lines`
      : "Show full output";

  return (
    <div className="relative group">
      {html ? (
        // Shiki output is a `<pre class="shiki">...`; force wrapping so long
        // lines don't blow out the row width (matches the plain-text path).
        <div
          className={cn("[&_pre]:whitespace-pre-wrap [&_pre]:!bg-transparent", className)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className={cn("whitespace-pre-wrap", className)}>{displayText}</pre>
      )}
      {isExpandable && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground text-[10px] mt-1.5 flex items-center gap-1 font-sans transition-colors cursor-pointer select-none"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="size-3" /> {showMoreLabel}
            </>
          )}
        </button>
      )}
    </div>
  );
}
