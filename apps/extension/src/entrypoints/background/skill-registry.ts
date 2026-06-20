import {
  discoverSkills,
  installSkill,
  uninstallSkill,
} from "@/lib/skills/installer";
import { skillsDb } from "@/lib/skills/skills-db";
import type { InstalledSkill, SpaceSkillConfig } from "@/lib/skills/types";

export interface SkillsRegistryState {
  skills: InstalledSkill[];
  spaceConfigs: SpaceSkillConfig[];
}

class BackgroundSkillRegistry {
  private skills: InstalledSkill[] = [];
  private spaceConfigs: SpaceSkillConfig[] = [];
  private initialized = false;

  async init() {
    if (this.initialized) return;
    this.skills = await skillsDb.listAll();
    this.spaceConfigs = await skillsDb.listAllSpaceConfigs();
    this.initialized = true;
    this.broadcastStateChange();
  }

  getStates(): SkillsRegistryState {
    return {
      skills: [...this.skills],
      spaceConfigs: [...this.spaceConfigs],
    };
  }

  async refreshFromDb() {
    this.skills = await skillsDb.listAll();
    this.spaceConfigs = await skillsDb.listAllSpaceConfigs();
    this.broadcastStateChange();
  }

  async install(
    source: string,
    githubToken?: string,
    specificSkill?: string,
  ): Promise<InstalledSkill[]> {
    let previews = await discoverSkills(source, githubToken);

    if (specificSkill) {
      previews = previews.filter((p) => p.name === specificSkill);
      if (previews.length === 0) {
        throw new Error(`Skill "${specificSkill}" not found in source.`);
      }
    }

    const installed: InstalledSkill[] = [];

    for (const preview of previews) {
      const skill = await installSkill(preview, githubToken);
      installed.push(skill);
    }

    await this.refreshFromDb();
    return installed;
  }

  async create(
    name: string,
    description: string,
    body: string,
    references?: { path: string; content: string }[],
  ): Promise<InstalledSkill> {
    const { createSkillLocally } = await import("@/lib/skills/installer");
    const skill = await createSkillLocally(name, description, body, references);
    await this.refreshFromDb();
    return skill;
  }

  async uninstall(name: string): Promise<void> {
    await uninstallSkill(name);
    await this.refreshFromDb();
  }

  /**
   * Create or overwrite a `kind: "site"` skill (per-domain reusable-script
   * store). Routed through the installer so OPFS + DB stay consistent.
   */
  async upsertSite(
    name: string,
    description: string,
    body: string,
    scripts?: { path: string; content: string }[],
  ): Promise<InstalledSkill> {
    const { upsertSiteSkill } = await import("@/lib/skills/installer");
    const skill = await upsertSiteSkill(name, description, body, scripts);
    await this.refreshFromDb();
    return skill;
  }

  /**
   * Apply a script-granular patch to a `kind: "site"` skill (create-or-update
   * named scripts / body / description without resending the whole skill).
   * Routed through the installer so OPFS + DB stay consistent.
   */
  async patchSite(
    name: string,
    patch: import("@/lib/skills/installer").SiteSkillPatch,
  ): Promise<InstalledSkill> {
    const { patchSiteSkill } = await import("@/lib/skills/installer");
    const skill = await patchSiteSkill(name, patch);
    await this.refreshFromDb();
    return skill;
  }

  /**
   * Delete a `kind: "site"` skill. Refuses non-site skills so the agent's
   * no-approval delete tool can't remove user-installed/regular skills.
   */
  async deleteSite(name: string): Promise<void> {
    const skill = await skillsDb.get(name);
    if (!skill) throw new Error(`Site skill "${name}" not found`);
    if (skill.kind !== "site") {
      throw new Error(`"${name}" is not a site skill; refusing to delete.`);
    }
    await uninstallSkill(name);
    await this.refreshFromDb();
  }

  async setSpaceState(
    spaceId: string,
    skillName: string,
    state: "allow" | "deny",
  ): Promise<void> {
    await skillsDb.setSpaceState(spaceId, skillName, state);
    await this.refreshFromDb();
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const skill = await skillsDb.get(name);
    if (!skill) throw new Error(`Skill "${name}" not found`);
    await skillsDb.save({ ...skill, enabled });
    await this.refreshFromDb();
  }

  broadcastStateChange() {
    chrome.runtime
      .sendMessage({
        type: "SKILL_STATE_CHANGED",
        state: this.getStates(),
      })
      .catch(() => {});
  }
}

export const backgroundSkillRegistry = new BackgroundSkillRegistry();
