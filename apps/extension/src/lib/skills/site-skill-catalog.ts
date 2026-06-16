import type { InstalledSkill } from "./types";

/**
 * Reduce a URL/host to its registrable domain key (matches a site skill's
 * name). Lowercases, strips scheme/path/port and a leading `www.`. Returns
 * null when the input isn't a usable hostname.
 */
export function urlToDomain(input: string): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    host = host.split("/")[0].split(":")[0];
  }
  host = host.replace(/^www\./, "");
  if (!host || host.includes("/") || !/^[a-z0-9.-]+$/.test(host)) return null;
  return host;
}

/**
 * Render the "## Site skills for open tabs" system-prompt block.
 *
 * For each distinct registrable domain among the currently-open tabs:
 *  - COVERED (an enabled `kind: "site"` skill named for that domain exists):
 *    list the skill name (= domain), description, and bundled script files so
 *    the agent can load it and run scripts BY REFERENCE.
  *  - UNCOVERED (no usable site skill yet): emit a short "no site skill yet"
  *    note telling the agent it can browse/script normally and that a site
  *    skill may be authored automatically by the background curator afterward.
  *    This keeps the reuse loop visible on a domain the agent has never
  *    scripted before (the previous behavior rendered nothing).
 *
 * The block renders whenever ANY open-tab domain is usable (covered OR
 * uncovered). Returns "" only when no open tab yields a parseable domain.
 * Pure/deterministic (no OPFS) so it's unit-testable.
 *
 * Per Q2, covered entries are a CATALOG (not a body dump): the agent calls
 * `skill({ name })` to load the full SKILL.md when a task on that domain needs
 * it, then runs a script via `executeOnPage({ scriptRef: { skill, script } })`.
 */
export function renderSiteSkillsBlock(
  openTabUrls: string[],
  siteSkills: InstalledSkill[],
): string {
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const url of openTabUrls) {
    const d = urlToDomain(url);
    if (d && !seen.has(d)) {
      seen.add(d);
      domains.push(d);
    }
  }
  if (domains.length === 0) return "";

  // Index usable (enabled) site skills by domain. A disabled skill is treated
  // as absent → the domain falls through to the uncovered/bootstrap branch.
  const byDomain = new Map<string, InstalledSkill>();
  for (const s of siteSkills) {
    if (s.kind === "site" && s.enabled !== false) byDomain.set(s.name, s);
  }

  const lines: string[] = [
    "## Site skills for open tabs",
    "",
    "A SITE SKILL is your saved per-domain knowledge + reusable page scripts (one per domain; the skill's name IS the domain). Run this loop whenever a task needs page data/automation on an open tab's domain:",
    "1. REUSE FIRST — if the domain below has a site skill, load it with `skill({ name })` (reads its SKILL.md: site notes + script catalog). If a listed script fits, run it: `executeOnPage({ tab, scriptRef: { skill, script }, args? })` — no approval, body stays out of your context. Don't re-derive what a script already covers.",
    "2. DON'T AUTHOR — new site skills are written by a background curator after the task ends; you do NOT save your own `executeOnPage` scripts. `patch_site_skill` refuses domains without an existing skill.",
    "3. SELF-HEAL — if an EXISTING script's `scriptRef` result is unreliable / inconsistent / wrong, re-derive inline then fix it via `patch_site_skill` (or `delete_site_skill` if fundamentally misconceived).",
  ];

  for (const domain of domains) {
    const s = byDomain.get(domain);
    if (s) {
      lines.push("", `### ${domain}`, s.description);
      const scripts = (s.fileIndex ?? []).filter(
        (f) => f !== "SKILL.md" && !f.includes("/"),
      );
      if (scripts.length > 0) {
        lines.push(
          `Scripts (run via executeOnPage scriptRef): ${scripts.join(", ")}. Load \`skill({ name: "${domain}" })\` for each script's purpose, args, and returns.`,
        );
      }
    } else {
      lines.push(
        "",
        `### ${domain} — no site skill yet`,
        `No saved scripts for this domain. Use snapshot/executeOnPage as normal; a site skill may be authored automatically after the task ends. You don't need to save anything yourself.`,
      );
    }
  }

  return lines.join("\n");
}
