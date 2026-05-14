import { z } from "zod";
import type { BrowserTool } from "../types";
import { sendSkillMessage } from "@/lib/skills/messages";
import type { InstalledSkill } from "@/lib/skills/types";

const parameters = z.object({
  source: z.string().describe("The source of the skill to install. Can be a GitHub repository (github:owner/repo), a GitHub URL, or a raw SKILL.md URL."),
});

type Input = z.infer<typeof parameters>;

type Output = 
  | { success: true; installed: InstalledSkill[] }
  | { error: string };

export const installSkillTool: BrowserTool<Input, Output> = {
  name: "install_skill",
  description: "Installs a new skill from a GitHub repository or URL. Use this when the user asks to find or install a skill.",
  parameters,
  approval: { required: true },
  execute: async ({ source }) => {
    try {
      const res = await sendSkillMessage({ type: "SKILL_INSTALL", source });
      return { success: true, installed: res.installed };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};
