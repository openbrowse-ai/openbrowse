/**
 * Single source of truth for OpenBrowse-owned tab-group title shapes.
 *
 * Used by:
 *   - `tab-scoping.ts:bindTabsToConversation` — sets the immediate
 *     placeholder title when a new group is created.
 *   - `group-label.ts:maybeGenerateGroupLabel` — overwrites the
 *     placeholder with an LLM-generated short label.
 *
 * Title shapes (all prefixed with "OB | "):
 *   - user:     `OB | <title>`
 *   - subagent: `OB | <parent> · <slug>`   (or `OB | <parent>` if slug blank)
 *   - mcp:      `OB | MCP · <title>`
 *
 * Why MCP gets a visible tag: groups created by external MCP hosts
 * should be distinguishable at a glance from the user's own chats so
 * the user can recognise "the agent did this" tabs. The same prefix
 * format is preserved across placeholder + LLM relabel so a group's
 * provenance never flickers between the two.
 *
 * `labelLength` is the per-segment slice budget for the dynamic
 * title (or LLM label). Placeholder code passes the per-segment
 * budget it currently uses (20 for user, 16 for subagent segments,
 * 14 for MCP). The labeler passes the LLM-output budget (19 for
 * user, 14 for MCP — narrower because the prefix is longer).
 */

export interface GroupTitleInputs {
  /** Conversation `source` field. Undefined treated as "user". */
  source?: "user" | "subagent" | "mcp";
  /** Conversation title, or LLM-generated label body. */
  title: string;
  /** Parent conversation's title — only used for subagent shape. */
  parentTitle?: string;
  /** Subagent slug — only used for subagent shape. */
  subagentSlug?: string;
  /**
   * Per-segment character budget for the dynamic content. Each
   * dynamic segment ("Chat" fallback, parent, slug, LLM body) is
   * sliced to this length. Subagent uses a stricter slice (16) for
   * each of its two segments regardless of `labelLength`.
   */
  labelLength: number;
}

const SUBAGENT_SEGMENT_LEN = 16;

/**
 * Build the final tab-group title string. Pure: takes everything it
 * needs as input and returns a string. Both call sites construct
 * `GroupTitleInputs` from the conversation row + the relevant text.
 */
export function buildGroupTitle(inputs: GroupTitleInputs): string {
  const source = inputs.source ?? "user";

  // MCP takes priority over subagent — users need to see "this came
  // from an external host" before they see the subagent slug.
  if (source === "mcp") {
    const raw = inputs.parentTitle ?? inputs.title;
    // Defensive: strip a leading "MCP:" or "MCP " token from the
    // source title so the label doesn't render as "OB | MCP · MCP:
    // do the thing" if a future code path prefixes the conversation
    // title with "MCP:" itself. Current callers don't do this (title
    // is set to the raw prompt prefix), but doing the strip here
    // makes the helper robust under future title-format changes.
    const stripped = raw.replace(/^\s*MCP\s*[:·-]?\s*/i, "");
    const base = pickNonEmptyOrChat(stripped);
    return `OB | MCP · ${slice(base, inputs.labelLength)}`;
  }

  if (source === "subagent") {
    const parent = pickNonEmptyOrChat(inputs.parentTitle ?? "");
    const slug = (inputs.subagentSlug ?? "").trim();
    if (slug) {
      return `OB | ${slice(parent, SUBAGENT_SEGMENT_LEN)} · ${slice(slug, SUBAGENT_SEGMENT_LEN)}`;
    }
    return `OB | ${slice(parent, SUBAGENT_SEGMENT_LEN)}`;
  }

  // Default = user
  const base = pickNonEmptyOrChat(inputs.title);
  return `OB | ${slice(base, inputs.labelLength)}`;
}

function pickNonEmptyOrChat(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : "Chat";
}

function slice(s: string, max: number): string {
  return s.slice(0, max);
}
