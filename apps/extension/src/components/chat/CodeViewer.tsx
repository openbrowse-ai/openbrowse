import { useEffect, useState } from "react";
import { getHighlighter, ensureLanguage } from "./shiki-core";

interface CodeViewerProps {
  code: string;
  language: string;
  className?: string;
  /**
   * When true, prepends a 1-indexed line number gutter to each rendered line
   * via CSS counters. The container CSS class `with-line-numbers` is applied
   * so callers can scope styling overrides.
   */
  lineNumbers?: boolean;
}

/**
 * Lightweight syntax-highlighted code viewer powered by Shiki's fine-grained
 * core API. Renders a single `<pre><code>` block with no chrome.
 */
export function CodeViewer({ code, language, className, lineNumbers }: CodeViewerProps) {
  const [html, setHtml] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function highlight() {
      try {
        const highlighter = await getHighlighter();
        const ok = await ensureLanguage(highlighter, language);
        const lang = ok ? language : "text";
        const out = highlighter.codeToHtml(code, {
          lang,
          themes: {
            light: "github-light-default",
            dark: "github-dark-default",
          },
          defaultColor: false,
        });
        if (!cancelled) setHtml(out);
      } catch {
        // On any failure, render raw code (handled by the !html branch below).
      }
    }
    highlight();
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (!html) {
    return (
      <pre className={className}>
        <code className="text-muted-foreground">{code}</code>
      </pre>
    );
  }

  const containerClass = [className, lineNumbers ? "with-line-numbers" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={containerClass}
      // Shiki returns sanitized HTML.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
