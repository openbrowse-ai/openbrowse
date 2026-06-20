export interface InstalledSkill {
  name: string; // matches SKILL.md frontmatter; folder name in OPFS
  description: string; // from frontmatter
  source: string; // e.g. "github:vercel-labs/agent-skills/react-best-practices"
  metadata: Record<string, unknown>; // version, author, etc. from frontmatter
  hasScripts: boolean;
  scriptTypes: string[]; // e.g. ["bash", "python"]
  fileIndex: string[]; // relative paths of all files written to OPFS
  installedAt: number;
  lastChecked?: number; // for update polling
  /**
   * Skill kind. `"site"` skills are per-domain (name === the registrable
   * domain, e.g. `linkedin.com`), agent-CRUD'd without approval, hold runnable
   * page scripts, and surface in a dedicated "Site skills" UI section. Omitted
   * / `"regular"` is the default (installed or hand-authored skills).
   */
  kind?: "regular" | "site";
  /**
   * Global enabled flag. When `false`, the skill is hidden from the agent's
   * "Available Skills" catalog regardless of per-space config. Defaults to
   * `true` (omitted = enabled) for backward compatibility with existing
   * stored skills.
   */
  enabled?: boolean;
}

export interface SpaceSkillConfig {
  spaceId: string;
  skillName: string;
  state: "allow" | "deny"; // default allow; deny hides from catalog in this space
}
