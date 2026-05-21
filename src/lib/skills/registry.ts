import type { SkillsRegistryState } from "@/entrypoints/background/skill-registry";
import { sendSkillMessage } from "./messages";

class SkillsRegistry {
  private state: SkillsRegistryState = { skills: [], spaceConfigs: [] };
  private listeners: Set<() => void> = new Set();
  private initialized = false;

  constructor() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "SKILL_STATE_CHANGED") {
        this.state = message.state;
        this.notifyListeners();
      }
    });
  }

  async init() {
    if (this.initialized) return;
    const res = await sendSkillMessage({ type: "SKILL_INIT" });
    if (res.success) {
      this.state = res.state;
      this.initialized = true;
      this.notifyListeners();
    }
  }

  getState(): SkillsRegistryState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  async install(source: string, githubToken?: string, specificSkill?: string) {
    return sendSkillMessage({
      type: "SKILL_INSTALL",
      source,
      githubToken,
      specificSkill,
    });
  }

  async uninstall(name: string) {
    return sendSkillMessage({ type: "SKILL_UNINSTALL", name });
  }

  async setSpaceState(
    spaceId: string,
    skillName: string,
    state: "allow" | "deny",
  ) {
    return sendSkillMessage({
      type: "SKILL_SET_SPACE_STATE",
      spaceId,
      skillName,
      state,
    });
  }

  async setEnabled(name: string, enabled: boolean) {
    return sendSkillMessage({ type: "SKILL_SET_ENABLED", name, enabled });
  }
}

let registryInstance: SkillsRegistry | null = null;

export function getSkillsRegistry(): SkillsRegistry {
  if (!registryInstance) {
    registryInstance = new SkillsRegistry();
  }
  return registryInstance;
}

// Eagerly initialize the registry so state is loaded before the user types `/`
getSkillsRegistry().init().catch(console.error);
