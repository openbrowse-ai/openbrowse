/**
 * Parse and format `@agent:<slug>` mentions in user input.
 *
 * Phase 2 ships this as a text-based recognition layer: the user types
 * `@agent:<slug>` in the chat input, and on submit we scan the text for
 * matches, validate against the registry, and emit a forced-delegation
 * prefix that the parent agent's LLM sees alongside the user message.
 *
 * The parent's first tool call for that turn must be `delegate({slug})`.
 * The parent still assembles the structured `DelegationContext` from the
 * user's other mentions (tabs, attachments, prose) — keeping a single
 * delegation code path through the parent.
 *
 * A future Phase will replace this with a proper Tiptap mention picker
 * that emits an `agentMention` node; for v2.0 the parser is sufficient.
 */

export interface ParsedAgentMention {
  slug: string;
}

/**
 * Match `@agent:<slug>` where:
 *  - `<slug>` is letters/digits/hyphens/underscores
 *  - first char must be a letter (not a digit) so we don't catch random
 *    tokens like `@agent:1`
 *  - preceded by start-of-string or a non-word character (avoids
 *    `email@agent:foo` false positives in pasted text)
 *
 * The capture group yields the slug.
 */
const AGENT_MENTION_RE = /(?:^|[^\w])@agent:([a-zA-Z][a-zA-Z0-9_-]*)/g;

/**
 * Extract the unique list of `@agent:<slug>` mentions from `text`, in
 * order of first appearance. Repeated mentions of the same slug
 * collapse to a single entry.
 */
export function parseAgentMentions(text: string): ParsedAgentMention[] {
  const seen = new Set<string>();
  const result: ParsedAgentMention[] = [];
  for (const m of text.matchAll(AGENT_MENTION_RE)) {
    const slug = m[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    result.push({ slug });
  }
  return result;
}

/**
 * Build the forced-delegation prefix string that gets prepended to the
 * model-visible user message. Returns the empty string when no
 * recognized agent slugs are present.
 *
 * `knownSlugs` is supplied by the caller (typically the agent registry)
 * so we never instruct the model to call a non-existent subagent.
 */
export function formatAgentMentionPrefix(
  mentions: ParsedAgentMention[],
  knownSlugs: ReadonlySet<string>,
): string {
  const recognized = mentions.filter((m) => knownSlugs.has(m.slug));
  if (recognized.length === 0) return "";

  const list = recognized.map((m) => `@agent:${m.slug}`).join(", ");
  const slugs = recognized.map((m) => m.slug).join(", ");

  return [
    "",
    "-----",
    "<Forced delegation>",
    `The user explicitly invoked the following subagent(s) for this turn: ${list}.`,
    `You MUST call the \`delegate\` tool with slug=${recognized.length === 1 ? `"${recognized[0].slug}"` : `one of [${slugs}]`} before producing any text response.`,
    `Build the \`task\` and structured \`context\` from the rest of the user's message and any tab mentions / attached files.`,
    "</Forced delegation>",
    "",
  ].join("\n");
}
