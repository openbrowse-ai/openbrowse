// src/lib/memory/format.ts
//
// Pure, dependency-free helpers for the file-based memory format (Memory v2).
//
// A memory is a markdown file with YAML frontmatter and a "compiled truth +
// timeline" body — the pattern from Garry Tan's `gbrain`, adapted here. The
// file is the source of truth; the IndexedDB index (see `memory-db.ts`) is a
// rebuildable cache derived from these files.
//
// Layout:
//   memory/<slug>.md                    global
//   spaces/<spaceId>/memory/<slug>.md   space-scoped
//
// Page format:
//   ---
//   title: PR review workflow
//   description: How the user likes PRs reviewed
//   type: reference
//   domain: github.com
//   aliases: [pr review, code review]
//   created: 2026-08-05
//   updated: 2026-08-05
//   ---
//
//   # Compiled truth
//
//   Current best understanding. Read first. May reference [[other-memory]].
//
//   # Timeline
//
//   - 2026-08-05 — Learned the staging URL is https://... [Source: chat]
//
// This module is intentionally free of OPFS / IndexedDB / chrome imports so it
// can be unit-tested in isolation and imported from any context.

export type MemoryType = "user" | "feedback" | "reference";

/** A memory is either global ("user") or scoped to a space ("space"). */
export type MemoryScope = "user" | "space";

export interface MemoryDoc {
  title: string;
  description: string;
  type: MemoryType;
  domain: string | null;
  aliases: string[];
  /** ISO date (YYYY-MM-DD). */
  created: string;
  /** ISO date (YYYY-MM-DD). */
  updated: string;
  /** The compiled-truth block — the current best understanding. */
  truth: string;
  /** Append-only dated timeline entries (without the leading "- "). */
  timeline: string[];
}

const COMPILED_TRUTH_HEADING = "# Compiled truth";
const TIMELINE_HEADING = "# Timeline";

/**
 * Turn a human title into a filesystem-safe slug. Lowercases, replaces runs of
 * non-alphanumeric characters with a single hyphen, and trims stray hyphens.
 * The slug doubles as the per-scope uniqueness key and the `[[wikilink]]`
 * target, so it must be stable for a given title.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    // Strip combining marks (accents) so "café" → "cafe".
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "memory";
}

/** Today's date as `YYYY-MM-DD` (UTC), for frontmatter + timeline entries. */
export function today(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Extract every `[[wikilink]]` target from `text`, normalized to **basename**
 * slugs and de-duplicated (order preserved). Links are bare basenames
 * (`[[garry-tan]]`) that resolve by filename regardless of folder. A
 * `[[slug|display text]]` alias form is supported (only the slug half is used),
 * and a stray path (`[[people/garry-tan]]`) collapses to its last segment so it
 * still resolves by basename.
 *
 * `[[chat:<conversationId>]]` is excluded: it's a provenance link to the source
 * conversation of a fact (see `linkify.ts`), not a reference to another note.
 * Treating it as one would add a bogus backlink row and a permanently dangling
 * node to the memory graph.
 */
export function parseLinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Non-greedy inner match; the `[^\]]` class prevents spanning past a `]`.
  const re = /\[\[([^\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].split("|")[0].trim();
    if (!raw) continue;
    if (/^chat:/i.test(raw)) continue;
    // Bare-basename scheme: resolve by filename, so a stray path collapses to
    // its final segment.
    const base = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
    const slug = slugify(base);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

/** OPFS path for a memory file given its slug and owning space (null = global). */
export function memoryFilePath(slug: string, spaceId: string | null): string {
  return spaceId === null
    ? `memory/${slug}.md`
    : `spaces/${spaceId}/memory/${slug}.md`;
}

/** Directory that holds a scope's memory files. */
export function memoryDirPath(spaceId: string | null): string {
  return spaceId === null ? "memory" : `spaces/${spaceId}/memory`;
}

export interface MemoryPathInfo {
  spaceId: string | null;
  scope: MemoryScope;
  /** Basename slug (filename without extension, slugified) — the link key. */
  slug: string;
  /** Path relative to the scope's memory root (may contain folders). */
  relPath: string;
}

/**
 * Parse a full OPFS path into its memory-scope info, or `null` when the path
 * isn't under a memory root or isn't a markdown file. Handles both
 * `memory/<...>.md` (global) and `spaces/<id>/memory/<...>.md` (scoped), with
 * arbitrary nested folders.
 */
export function parseMemoryPath(fullPath: string): MemoryPathInfo | null {
  const clean = fullPath.replace(/^\/+/, "");
  let spaceId: string | null = null;
  let rel: string;
  if (clean === "memory" || clean.startsWith("memory/")) {
    rel = clean.slice("memory/".length);
  } else {
    const m = clean.match(/^spaces\/([^/]+)\/memory\/(.+)$/);
    if (!m) return null;
    spaceId = m[1];
    rel = m[2];
  }
  if (!rel || !rel.endsWith(".md")) return null;
  const base = rel.split("/").pop() ?? rel;
  const slug = slugify(base.replace(/\.md$/, ""));
  return {
    spaceId,
    scope: spaceId === null ? "user" : "space",
    slug,
    relPath: rel,
  };
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
  fields: Record<string, string | string[]>;
  body: string;
}

/**
 * Split a file into its frontmatter fields and body. Tolerant of a missing
 * frontmatter block (returns empty fields + the whole content as body) so a
 * hand-edited or malformed file still degrades to something searchable.
 */
function splitFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };

  const fields: Record<string, string | string[]> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let raw = line.slice(colon + 1).trim();
    if (!key) continue;
    if (raw.startsWith("[") && raw.endsWith("]")) {
      // Inline array: [a, b, c]
      const inner = raw.slice(1, -1).trim();
      fields[key] = inner
        ? inner
            .split(",")
            .map((s) => stripQuotes(s.trim()))
            .filter(Boolean)
        : [];
    } else {
      fields[key] = stripQuotes(raw);
    }
  }
  return { fields, body: match[2] };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Quote a scalar for frontmatter only when it could confuse the parser. */
function quoteScalar(value: string): string {
  if (value === "") return '""';
  // Quote when the value starts with a special YAML char or contains a colon
  // followed by space (which our splitter would misread), or leading/trailing
  // whitespace.
  if (
    /^[\[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s/.test(value) ||
    value !== value.trim()
  ) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Body (compiled truth + timeline)
// ---------------------------------------------------------------------------

/**
 * Parse the body into a compiled-truth block and a list of timeline entries.
 * If the body has no headings (e.g. a hand-written note), the whole thing is
 * treated as compiled truth with an empty timeline.
 */
function parseBody(body: string): { truth: string; timeline: string[] } {
  const truthIdx = body.indexOf(COMPILED_TRUTH_HEADING);
  const timelineIdx = body.indexOf(TIMELINE_HEADING);

  if (truthIdx === -1 && timelineIdx === -1) {
    return { truth: body.trim(), timeline: [] };
  }

  let truthText = "";
  if (truthIdx !== -1) {
    const start = truthIdx + COMPILED_TRUTH_HEADING.length;
    const end =
      timelineIdx !== -1 && timelineIdx > truthIdx ? timelineIdx : body.length;
    truthText = body.slice(start, end).trim();
  }

  const timeline: string[] = [];
  if (timelineIdx !== -1) {
    const timelineText = body
      .slice(timelineIdx + TIMELINE_HEADING.length)
      .trim();
    for (const line of timelineText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("-")) {
        const entry = trimmed.replace(/^-\s*/, "").trim();
        if (entry) timeline.push(entry);
      }
    }
  }

  return { truth: truthText, timeline };
}

/** Parse a full memory file (frontmatter + body) into a MemoryDoc. */
export function parseMemory(content: string): MemoryDoc {
  const { fields, body } = splitFrontmatter(content);
  const { truth, timeline } = parseBody(body);

  const type = normalizeType(fields.type);
  const aliases = Array.isArray(fields.aliases)
    ? fields.aliases
    : typeof fields.aliases === "string" && fields.aliases
      ? [fields.aliases]
      : [];

  return {
    title: asString(fields.title) || "",
    description: asString(fields.description) || "",
    type,
    domain: asString(fields.domain) || null,
    aliases,
    created: asString(fields.created) || today(),
    updated: asString(fields.updated) || today(),
    truth,
    timeline,
  };
}

function asString(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

function normalizeType(v: string | string[] | undefined): MemoryType {
  const s = typeof v === "string" ? v : "";
  return s === "user" || s === "feedback" ? s : "reference";
}

/** Serialize a MemoryDoc back into file text. */
export function serializeMemory(doc: MemoryDoc): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${quoteScalar(doc.title)}`);
  lines.push(`description: ${quoteScalar(doc.description)}`);
  lines.push(`type: ${doc.type}`);
  if (doc.domain) lines.push(`domain: ${quoteScalar(doc.domain)}`);
  if (doc.aliases.length > 0) {
    lines.push(`aliases: [${doc.aliases.map(quoteScalar).join(", ")}]`);
  }
  lines.push(`created: ${doc.created}`);
  lines.push(`updated: ${doc.updated}`);
  lines.push("---");
  lines.push("");
  lines.push(COMPILED_TRUTH_HEADING);
  lines.push("");
  lines.push(doc.truth.trim());
  lines.push("");
  lines.push(TIMELINE_HEADING);
  lines.push("");
  if (doc.timeline.length === 0) {
    // Keep the section present but empty; downstream tooling relies on both
    // headings existing.
  } else {
    for (const entry of doc.timeline) {
      lines.push(`- ${entry}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * The full searchable text for a doc: title, description, aliases, compiled
 * truth, and timeline entries, joined. Used by the keyword scorer.
 */
export function searchableText(doc: MemoryDoc): string {
  return [
    doc.title,
    doc.description,
    doc.aliases.join(" "),
    doc.truth,
    doc.timeline.join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Collapse arbitrary text into a single line suitable for a timeline entry
 * (which must not contain internal newlines, or the list item would break the
 * body parser). Whitespace runs collapse to single spaces; long text is
 * truncated so the timeline log can't grow pathologically.
 */
export function collapseForTimeline(text: string, max = 500): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max
    ? collapsed.slice(0, max - 1) + "\u2026"
    : collapsed;
}

/** Lowercase word tokens for keyword search, de-duplicated. */
export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/**
 * Weighted keyword score for a doc against pre-tokenized query terms. Field
 * weights (title > aliases > description > body) mean a term in the title
 * counts for much more than the same term buried in the timeline. A whole-query
 * substring hit in the title adds a strong bonus so exact recalls rank first.
 * Returns 0 when nothing matches.
 */
export function keywordScore(doc: MemoryDoc, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const title = doc.title.toLowerCase();
  const aliases = doc.aliases.join(" ").toLowerCase();
  const description = doc.description.toLowerCase();
  const body = `${doc.truth}\n${doc.timeline.join("\n")}`.toLowerCase();

  let score = 0;
  for (const t of tokens) {
    if (title.includes(t)) score += 10;
    if (aliases.includes(t)) score += 8;
    if (description.includes(t)) score += 4;
    if (body.includes(t)) score += 2;
  }
  const phrase = tokens.join(" ");
  if (title.includes(phrase)) score += 8;
  if (slugify(doc.title) === slugify(phrase)) score += 20;
  return score;
}

/**
 * Produce a short snippet for a search result: the first body line that
 * contains a query term, else the opening of the compiled truth.
 */
export function makeSnippet(
  doc: MemoryDoc,
  tokens: string[],
  max = 200,
): string {
  const lines = doc.truth.split(/\r?\n/).filter((l) => l.trim());
  const hit = lines.find((l) =>
    tokens.some((t) => l.toLowerCase().includes(t)),
  );
  const base = (hit ?? lines[0] ?? doc.description ?? "").trim();
  return base.length > max ? base.slice(0, max - 1) + "\u2026" : base;
}

/**
 * A stable, fast, non-cryptographic content hash (FNV-1a, 32-bit, hex). Used
 * only for staleness detection between an OPFS file and its index row — not
 * for anything security-sensitive.
 */
export function contentHash(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in int range.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
