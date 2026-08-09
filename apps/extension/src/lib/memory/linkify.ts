// src/lib/memory/linkify.ts
//
// Pure markdown pre-processing for the memory viewer (Memory v2).
//
// Memory notes are plain markdown authored by the agent, so anything we want to
// make interactive has to survive a round trip through the markdown renderer.
// The trick used throughout is to rewrite our own syntax into a **fragment
// link** (`#wl-…`, `#chat-…`): fragment hrefs pass react-markdown's default URL
// sanitization untouched (an invented `openbrowse://` scheme would be stripped)
// and never navigate the page, so the renderer hands us a real anchor that the
// `Markdown` component intercepts on click.
//
// Three rewrites happen here:
//
//   1. `[[chat:<conversationId>]]`  → a link back to the conversation the fact
//      came from. Rendered label defaults to "chat" so the long-standing
//      `[Source: chat]` timeline convention looks identical — just clickable.
//   2. `[[note-name]]` / `[[note|display]]` → an in-app link to another note,
//      resolved by basename (see `parseLinks` in `format.ts`).
//   3. `[Source: example.com/path]` → a real external link. GFM autolinks a
//      bare `https://…` but NOT a scheme-less domain, which is how the agent
//      tends to write citations, so those rendered as dead text.
//
// This module is intentionally free of OPFS / IndexedDB / React / chrome
// imports so it can be unit-tested directly.

/** Fragment-href prefix for an in-app link to another memory note. */
export const WIKILINK_HREF_PREFIX = "#wl-";

/** Fragment-href prefix for a link to the source conversation of a fact. */
export const CHATLINK_HREF_PREFIX = "#chat-";

/** Wikilink target prefix marking a source-conversation reference. */
const CHAT_SCHEME = "chat:";

/** Default label for a `[[chat:…]]` link with no explicit display text. */
const CHAT_DEFAULT_LABEL = "chat";

/**
 * Extensions that parse as a domain (`.ts` and `.sh` really are TLDs) but in a
 * `[Source: …]` citation are overwhelmingly filenames. Denying them keeps
 * `[Source: format.ts]` from turning into a link to a Tuvaluan website.
 */
const FILE_EXT_DENYLIST = new Set([
  "bash",
  "cfg",
  "conf",
  "css",
  "csv",
  "env",
  "gif",
  "gz",
  "htm",
  "html",
  "ini",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsonc",
  "jsx",
  "lock",
  "log",
  "md",
  "mdx",
  "mjs",
  "pdf",
  "png",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svg",
  "tar",
  "toml",
  "ts",
  "tsx",
  "txt",
  "webp",
  "xml",
  "yaml",
  "yml",
  "zip",
]);

/**
 * Domain-shaped token: one or more dot-separated labels, an alphabetic TLD, an
 * optional port, and an optional path/query/fragment tail.
 */
const DOMAIN_TOKEN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:[/?#]\S*)?$/i;

/** A `[Source: <token>]` citation, where the token contains no space or `]`. */
const SOURCE_REF_RE = /\[Source:\s*([^\]\s]+)\s*\]/gi;

/** `[[target]]` / `[[target|display]]`, non-greedy and never spanning a `]`. */
const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;

/** True when `token` looks like a scheme-less URL we should linkify. */
export function isBareDomain(token: string): boolean {
  if (!DOMAIN_TOKEN_RE.test(token)) return false;
  const host = token.split(/[/?#]/)[0].split(":")[0];
  const tld = host.slice(host.lastIndexOf(".") + 1).toLowerCase();
  return !FILE_EXT_DENYLIST.has(tld);
}

/**
 * Turn the URL inside a `[Source: …]` citation into an explicit markdown link.
 *
 * Scheme-ful URLs are normalized too rather than left to GFM autolinking: the
 * autolink extension's trailing-punctuation rules don't exclude the `]` that
 * closes the citation, so `[Source: https://x.com/a]` can otherwise absorb the
 * bracket into the href. An angle-bracket destination (`[text](<url>)`) keeps
 * parens and other path characters from terminating the link early.
 *
 * Citations already carrying markup (`[[chat:…]]`, an existing markdown link,
 * an autolink) are left for the wikilink pass or the renderer to handle.
 */
function linkifySourceRefs(md: string): string {
  return md.replace(SOURCE_REF_RE, (full: string, rawInner: string) => {
    const inner = rawInner.trim();
    if (!inner) return full;
    // Already marked up, or contains characters we can't safely put in an
    // angle-bracket link destination.
    if (/^[[(!<]/.test(inner) || inner.includes("<") || inner.includes(">")) {
      return full;
    }
    const hasScheme = /^https?:\/\//i.test(inner);
    if (!hasScheme && !isBareDomain(inner)) return full;
    const url = hasScheme ? inner : `https://${inner}`;
    const display = inner
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "")
      // `]` can't occur (the capture excludes it); `[` would break the label.
      // Backslashes go first, or an existing `\` would turn the escape we add
      // into a literal backslash and leave the `[` unescaped.
      .replace(/\\/g, "\\\\")
      .replace(/\[/g, "\\[");
    return `[Source: [${display}](<${url}>)]`;
  });
}

/**
 * Rewrite `[[…]]` spans into fragment links the `Markdown` component
 * intercepts. `[[chat:<id>]]` becomes a source-conversation link; everything
 * else becomes a note link whose target collapses to its basename (matching the
 * memory link model, so links survive moving a file between folders).
 */
function linkifyWikilinks(md: string): string {
  return md.replace(WIKILINK_RE, (full: string, inner: string) => {
    const [rawTarget, rawDisplay] = inner.split("|");
    const target = rawTarget.trim();
    if (!target) return full;
    const display = rawDisplay?.trim().replace(/[[\]]/g, "");

    if (target.toLowerCase().startsWith(CHAT_SCHEME)) {
      const id = target.slice(CHAT_SCHEME.length).trim();
      if (!id) return full;
      const label = display || CHAT_DEFAULT_LABEL;
      return `[${label}](${CHATLINK_HREF_PREFIX}${encodeURIComponent(id)})`;
    }

    const base = target.includes("/")
      ? target.slice(target.lastIndexOf("/") + 1)
      : target;
    // The label is sanitized like `display` (a `[` would leave it unbalanced),
    // but the href keeps the raw basename so resolution still matches the file.
    const label = display || base.replace(/[[\]]/g, "");
    return `[${label}](${WIKILINK_HREF_PREFIX}${encodeURIComponent(base)})`;
  });
}

/**
 * Full memory-markdown pre-pass. Order matters: source citations are rewritten
 * first, while `[[chat:…]]` is still bracket syntax that `linkifySourceRefs`
 * recognizes as "already marked up" and skips. Running it second would let it
 * match the `]` inside the markdown link the wikilink pass just emitted.
 */
export function linkifyMemoryMarkdown(md: string): string {
  return linkifyWikilinks(linkifySourceRefs(md));
}
