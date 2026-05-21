import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

/**
 * Map of supported languages → dynamic import. Each becomes its own chunk so
 * we only pay download cost for the languages a user actually opens.
 *
 * Add new entries as needed; unknown languages fall back to plain "text".
 */
export const LANG_LOADERS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
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
let highlighterSync: HighlighterCore | null = null;

export function getHighlighter(syncOnly = false): HighlighterCore | Promise<HighlighterCore> | null {
  if (syncOnly) {
    return highlighterSync;
  }
  
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [
        import("shiki/themes/github-light-default.mjs"),
        import("shiki/themes/github-dark-default.mjs"),
      ],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    }).then((h) => {
      highlighterSync = h;
      return h;
    });
  }
  return highlighterPromise;
}

const loadedLangs = new Set<string>();

export async function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<boolean> {
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