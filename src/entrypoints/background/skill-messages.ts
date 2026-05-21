import { backgroundSkillRegistry } from "./skill-registry";
import { OPFS } from "@/lib/vfs/opfs";

export async function handleSkillMessage(message: any, sendResponse: (response?: any) => void) {
  try {
    switch (message.type) {
      case "SKILL_INIT": {
        await backgroundSkillRegistry.init();
        sendResponse({ success: true, state: backgroundSkillRegistry.getStates() });
        break;
      }
      case "SKILL_GET_STATE": {
        sendResponse({ success: true, state: backgroundSkillRegistry.getStates() });
        break;
      }
      case "SKILL_INSTALL": {
        const { source, githubToken } = message;
        const installed = await backgroundSkillRegistry.install(source, githubToken);
        sendResponse({ success: true, installed });
        break;
      }
      case "SKILL_CREATE": {
        const { name, description, body, references } = message;
        const installed = await backgroundSkillRegistry.create(name, description, body, references);
        sendResponse({ success: true, installed });
        break;
      }
      case "SKILL_UNINSTALL": {
        const { name } = message;
        await backgroundSkillRegistry.uninstall(name);
        sendResponse({ success: true });
        break;
      }
      case "SKILL_SET_SPACE_STATE": {
        const { spaceId, skillName, state } = message;
        await backgroundSkillRegistry.setSpaceState(spaceId, skillName, state);
        sendResponse({ success: true });
        break;
      }
      case "SKILL_READ_OPFS_FILE": {
        const { path } = message;
        const content = await OPFS.readFile(path);
        sendResponse({ success: true, content });
        break;
      }
      case "SKILL_GET_BODY": {
        const { name } = message;
        const state = backgroundSkillRegistry.getStates();
        const skill = state.skills.find((s) => s.name === name);
        if (!skill) {
          throw new Error(`Skill ${name} not found`);
        }
        const body = await OPFS.readFile(`skills/${name}/SKILL.md`);
        sendResponse({ 
          success: true, 
          body, 
          hasScripts: skill.hasScripts, 
          scriptTypes: skill.scriptTypes 
        });
        break;
      }
      default:
        console.warn("Unknown skill message type:", message.type);
        sendResponse({ success: false, error: "Unknown message type" });
        break;
    }
  } catch (err) {
    console.error("Error handling skill message:", message.type, err);
    sendResponse({ 
      success: false, 
      error: err instanceof Error ? err.message : String(err) 
    });
  }
}
