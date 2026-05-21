/**
 * Helpers for rendering a skill's `source` field in the UI:
 *   - "Added by" → human-readable provider name
 *   - "Source"   → optional clickable link to the upstream repo root
 *
 * Supported source formats:
 *   github:owner/repo
 *   github:owner/repo/sub/path
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main/sub/path
 *   bundled
 *   <anything else>           (fallback: treat as a free-form label)
 */

export interface SourceInfo {
  /** The org/repo to display, e.g. "anthropics/claude-skills". */
  displayName: string;
  /** Repo root URL, suitable for `<a target="_blank">`. */
  repoUrl: string;
  /** Org name only, e.g. "anthropics". Used for "Added by". */
  org: string;
}

/** Capitalize a slug like "anthropics" → "Anthropics", "open-browse" → "Open browse". */
function humanize(slug: string): string {
  if (!slug) return slug;
  // Replace separators with spaces and capitalize first character only — keeps
  // names like "anthropics" → "Anthropics" without forcing title case on
  // multi-word slugs that the publisher chose intentionally.
  const cleaned = slug.replace(/[-_]/g, " ");
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Parse a skill source string into structured info, or `null` if the source
 * doesn't reference a known host (e.g. `bundled`, plain text, or unknown URL).
 */
export function parseSkillSource(source: string): SourceInfo | null {
  if (!source) return null;

  // github:owner/repo[/...]
  const githubProto = source.match(/^github:([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (githubProto) {
    const owner = githubProto[1];
    const repo = githubProto[2];
    return {
      org: owner,
      displayName: `${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  // https://github.com/owner/repo[/...]
  const githubUrl = source.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/i,
  );
  if (githubUrl) {
    const owner = githubUrl[1];
    const repo = githubUrl[2].replace(/\.git$/, "");
    return {
      org: owner,
      displayName: `${owner}/${repo}`,
      repoUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  return null;
}

/**
 * "Added by" label for a skill. Falls back to the source string itself when
 * the source can't be parsed as a known host (e.g. local upload, bundled).
 */
export function addedByForSkill(
  source: string,
  metadata: Record<string, unknown> | undefined,
): string {
  if (source === "bundled") {
    const author = metadata?.author;
    if (typeof author === "string" && author.trim()) return author;
    return "OpenBrowse";
  }

  // Prefer YAML `author` if the skill explicitly set one.
  const author = metadata?.author;
  if (typeof author === "string" && author.trim()) return author;

  const parsed = parseSkillSource(source);
  if (parsed) return humanize(parsed.org);

  return source;
}
