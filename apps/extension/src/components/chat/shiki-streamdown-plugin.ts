import type { CodeHighlighterPlugin } from "streamdown";
import { getHighlighter, ensureLanguage, LANG_LOADERS } from "./shiki-core";

/**
 * Custom Streamdown plugin that bridges to our shared Shiki core instance.
 * Avoids bundling all 200+ Shiki languages by using our curated allowlist.
 */
export const codePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  supportsLanguage: (lang: string) => lang in LANG_LOADERS,
  getSupportedLanguages: () => Object.keys(LANG_LOADERS) as any[],
  getThemes: () => ["github-light-default", "github-dark-default"],
  highlight: (options, callback) => {
    // 1. Is highlighter initialized yet?
    const highlighter = getHighlighter(true);
    if (!highlighter) {
      // Async initialization path
      getHighlighter().then((h) => {
        ensureLanguage(h, options.language).then((ok) => {
          const lang = ok ? options.language : "text";
          const tokens = h.codeToTokens(options.code, {
            lang,
            themes: {
              light: "github-light-default",
              dark: "github-dark-default",
            },
            defaultColor: false,
          });
          callback?.(tokens as any);
        });
      });
      return null;
    }

    // 2. Is the language loaded yet?
    if (!highlighter.getLoadedLanguages().includes(options.language)) {
      ensureLanguage(highlighter, options.language).then((ok) => {
        const lang = ok ? options.language : "text";
        const tokens = highlighter.codeToTokens(options.code, {
          lang,
          themes: {
            light: "github-light-default",
            dark: "github-dark-default",
          },
          defaultColor: false,
        });
        callback?.(tokens as any);
      });
      return null;
    }

    // 3. Synchronous path - we have both highlighter and grammar ready
    const tokens = highlighter.codeToTokens(options.code, {
      lang: options.language,
      themes: {
        light: "github-light-default",
        dark: "github-dark-default",
      },
      defaultColor: false,
    });
    return tokens as any;
  },
};