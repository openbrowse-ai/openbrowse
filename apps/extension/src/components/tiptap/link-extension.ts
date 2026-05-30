import { Link } from "@tiptap/extension-link";

/**
 * Link mark that renders and round-trips explicit markdown links but
 * never auto-detects URLs in typed or pasted text.
 *
 * The stock Link extension (bundled by StarterKit) converts URL
 * substrings to link marks via three independent mechanisms:
 *   1. `autolink` — a ProseMirror plugin that fires while typing.
 *   2. `linkOnPaste` — wraps a paste that is a single bare URL.
 *   3. `addPasteRules` — a mark paste rule that scans EVERY paste with
 *      linkify and wraps every URL substring it finds. This one is NOT
 *      gated by the `autolink` option.
 *
 * Mechanism (3) is what corrupts a pasted markdown link such as
 * `[news.google.com](http://news.google.com)`: linkify finds the
 * `news.google.com` and `http://news.google.com` substrings *inside*
 * the literal text and wraps each in a link mark, so `getMarkdown()`
 * re-emits them as `[...](...)`, nesting one extra layer on every
 * copy/paste/resend cycle:
 *   [[news.google.com](http://news.google.com)]([http://news.google.com](http://news.google.com))
 *
 * Disabling all three keeps what you type/paste verbatim, while the
 * mark's `parseMarkdown`/`renderMarkdown` are preserved so deliberate
 * `[text](url)` links still round-trip and render as clickable links.
 */
export const NoAutoLink = Link.extend({
  // `addPasteRules` is not configurable via options, so override it.
  addPasteRules() {
    return [];
  },
}).configure({
  autolink: false,
  linkOnPaste: false,
  openOnClick: false,
});
