import { skillsDb } from "@/lib/skills/skills-db";
import { discoverSkills, installSkill, uninstallSkill } from "@/lib/skills/installer";
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

  async install(source: string, githubToken?: string): Promise<InstalledSkill[]> {
    const previews = await discoverSkills(source, githubToken);
    const installed: InstalledSkill[] = [];
    
    for (const preview of previews) {
      const skill = await installSkill(preview, githubToken);
      installed.push(skill);
    }
    
    await this.refreshFromDb();
    return installed;
  }

  async create(name: string, description: string, body: string, references?: {path: string, content: string}[]): Promise<InstalledSkill> {
    const { createSkillLocally } = await import("@/lib/skills/installer");
    const skill = await createSkillLocally(name, description, body, references);
    await this.refreshFromDb();
    return skill;
  }

  async uninstall(name: string): Promise<void> {
    await uninstallSkill(name);
    await this.refreshFromDb();
  }

  async setSpaceState(spaceId: string, skillName: string, state: "allow" | "deny"): Promise<void> {
    await skillsDb.setSpaceState(spaceId, skillName, state);
    await this.refreshFromDb();
  }

  broadcastStateChange() {
    chrome.runtime.sendMessage({ 
      type: "SKILL_STATE_CHANGED", 
      state: this.getStates() 
    }).catch(() => {});
  }
}

export const backgroundSkillRegistry = new BackgroundSkillRegistry();
