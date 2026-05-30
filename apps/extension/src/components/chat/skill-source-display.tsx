import { parseSource } from "@/lib/skills/source-parser";
import { DownloadCloud } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export interface SkillSourceDisplay {
  kind: "github" | "raw-skill-md" | "invalid";
  /** Humanized skill name derived from the source (last subpath segment,
   * else repo, else the raw source). */
  skillName: string;
  owner?: string;
  /** Repo root URL, suitable for an external link. */
  repoUrl?: string;
  /** GitHub owner avatar URL. */
  avatarUrl?: string;
  /** "owner/repo" (+ "/subpath" when present) for the source link label. */
  ownerRepoLabel?: string;
  /** Original source string, for fallback display. */
  raw: string;
}

/**
 * Humanize a slug like "sales-attio" → "Sales attio", "react_best_practices"
 * → "React best practices". Capitalizes the first character only — keeps
 * intentionally-cased multi-word slugs intact.
 */
function humanize(slug: string): string {
  if (!slug) return slug;
  const cleaned = slug.replace(/[-_]/g, " ").trim();
  if (!cleaned) return slug;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Last non-empty path segment, e.g. "sales/sales-attio" → "sales-attio". */
function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Derive display metadata for a skill `source` string at install time.
 *
 * Used by both the install-skill approval card and the post-install
 * result card so they present a consistent name / publisher / link.
 * Built on the same `parseSource` the install pipeline uses, so the
 * derived owner/repo always match what actually gets fetched.
 */
export function resolveSkillSourceDisplay(source: string): SkillSourceDisplay {
  const raw = source;
  const parsed = parseSource(source);

  if (parsed.kind === "github") {
    const { owner, repo, subpath } = parsed;
    // Prefer the skill's own folder (subpath) for the name; fall back to
    // the repo when the source points at a repo root.
    const nameSlug = subpath ? lastSegment(subpath) : repo;
    return {
      kind: "github",
      skillName: humanize(nameSlug),
      owner,
      repoUrl: `https://github.com/${owner}/${repo}`,
      avatarUrl: `https://github.com/${owner}.png`,
      ownerRepoLabel: subpath
        ? `${owner}/${repo}/${subpath}`
        : `${owner}/${repo}`,
      raw,
    };
  }

  if (parsed.kind === "raw-skill-md") {
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/.../SKILL.md
    let skillName = "Skill";
    let owner: string | undefined;
    let avatarUrl: string | undefined;
    try {
      const url = new URL(parsed.url);
      const segs = url.pathname.split("/").filter(Boolean);
      // [owner, repo, ref, ...path, "SKILL.md"] → name from the folder
      // holding SKILL.md.
      if (segs.length >= 2) {
        owner = segs[0];
        avatarUrl = `https://github.com/${owner}.png`;
      }
      const folder = segs.length >= 2 ? segs[segs.length - 2] : undefined;
      if (folder) skillName = humanize(folder);
    } catch {
      // keep defaults
    }
    return {
      kind: "raw-skill-md",
      skillName,
      owner,
      repoUrl: parsed.url,
      avatarUrl,
      ownerRepoLabel: owner,
      raw,
    };
  }

  // invalid / unrecognized → show the raw source verbatim.
  return {
    kind: "invalid",
    skillName: raw,
    raw,
  };
}

/**
 * Owner avatar for a skill source, with a graceful fallback to the
 * download-cloud glyph when there's no avatar URL or the image fails to
 * load (blocked request, 404, offline). Shared by the approval card and
 * the install result card so they look identical.
 */
export function SkillSourceAvatar({
  avatarUrl,
  className,
}: {
  avatarUrl?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box = cn(
    "shrink-0 grid place-items-center rounded-md overflow-hidden size-7 bg-muted",
    className,
  );
  if (!avatarUrl || failed) {
    return (
      <div className={box}>
        <DownloadCloud className="size-4 text-primary" />
      </div>
    );
  }
  return (
    <img
      src={avatarUrl}
      alt=""
      className={cn(box, "object-cover")}
      onError={() => setFailed(true)}
    />
  );
}

