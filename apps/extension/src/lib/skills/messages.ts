import type { SkillsRegistryState } from "@/entrypoints/background/skill-registry";
import type { InstalledSkill } from "./types";

export function sendSkillMessage(message: {
  type: "SKILL_INIT";
}): Promise<{ success: boolean; state: SkillsRegistryState }>;
export function sendSkillMessage(message: {
  type: "SKILL_GET_STATE";
}): Promise<{ success: boolean; state: SkillsRegistryState }>;
export function sendSkillMessage(message: {
  type: "SKILL_INSTALL";
  source: string;
  githubToken?: string;
  specificSkill?: string;
}): Promise<{ success: boolean; installed: InstalledSkill[] }>;
export function sendSkillMessage(message: {
  type: "SKILL_UNINSTALL";
  name: string;
}): Promise<{ success: boolean }>;
export function sendSkillMessage(message: {
  type: "SKILL_SET_SPACE_STATE";
  spaceId: string;
  skillName: string;
  state: "allow" | "deny";
}): Promise<{ success: boolean }>;
export function sendSkillMessage(message: {
  type: "SKILL_SET_ENABLED";
  name: string;
  enabled: boolean;
}): Promise<{ success: boolean }>;
export function sendSkillMessage(message: {
  type: "SKILL_GET_BODY";
  name: string;
}): Promise<{
  success: boolean;
  body?: string;
  hasScripts?: boolean;
  scriptTypes?: string[];
  error?: string;
}>;
export function sendSkillMessage(message: {
  type: "SKILL_CREATE";
  name: string;
  description: string;
  body: string;
  references?: { path: string; content: string }[];
}): Promise<{ success: boolean; installed: InstalledSkill }>;

export async function sendSkillMessage(message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}
