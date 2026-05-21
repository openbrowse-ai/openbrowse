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
