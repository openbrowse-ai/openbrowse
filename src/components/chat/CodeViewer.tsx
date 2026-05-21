import { useEffect, useState } from "react";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

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
 * Map of supported languages → dynamic import. Each becomes its own chunk so
 * we only pay download cost for the languages a user actually opens.
 *
 * Add new entries as needed; unknown languages fall back to plain "text".
 */
const LANG_LOADERS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
};

/**
 * Singleton Shiki highlighter. Created lazily on first highlight() call.
 *
 * We use the fine-grained `shiki/core` API + dynamic language imports so the
 * extension bundle stays small (~700 KB base) instead of pulling in every
 * language grammar (~9 MB).
 */
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [
        import("shiki/themes/github-light-default.mjs"),
        import("shiki/themes/github-dark-default.mjs"),
      ],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
  }
  return highlighterPromise;
}

const loadedLangs = new Set<string>();

async function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<boolean> {
  if (highlighter.getLoadedLanguages().includes(lang)) {
    loadedLangs.add(lang);
    return true;
  }
  const loader = LANG_LOADERS[lang];
  if (!loader) return false;
  try {
    const mod = await loader();
    await highlighter.loadLanguage(mod.default);
    loadedLangs.add(lang);
    return true;
  } catch {
    return false;
  }
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
