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
export function sendSkillMessage(message: {
  type: "SKILL_UPSERT_SITE";
  name: string;
  description: string;
  body: string;
  scripts?: { path: string; content: string }[];
}): Promise<{ success: boolean; installed: InstalledSkill }>;
export function sendSkillMessage(message: {
  type: "SKILL_PATCH_SITE";
  name: string;
  description?: string;
  body?: string;
  upsertScripts?: { path: string; content: string }[];
  deleteScripts?: string[];
}): Promise<{ success: boolean; installed: InstalledSkill }>;
export function sendSkillMessage(message: {
  type: "SKILL_DELETE_SITE";
  name: string;
}): Promise<{ success: boolean }>;

export async function sendSkillMessage(message: any): Promise<any> {
  // Realm-aware dispatch: when called from the SW (e.g. by the SW-hosted
  // agent loop calling skill tools), in-process call to the SW handler;
  // when called from a renderer, plain chrome.runtime.sendMessage. See
  // `@/lib/runtime/sw-rpc` for why.
  const { swRpc } = await import("@/lib/runtime/sw-rpc");
  const response = await swRpc(message, async () => {
    const mod = await import("@/entrypoints/background/skill-messages");
    return mod.handleSkillMessage as never;
  });
  // Preserve legacy reject-on-error semantics so call sites that
  // expected a thrown Error continue to work.
  if (response && typeof response === "object") {
    const r = response as { error?: string };
    if (r.error) throw new Error(r.error);
  }
  return response;
}
