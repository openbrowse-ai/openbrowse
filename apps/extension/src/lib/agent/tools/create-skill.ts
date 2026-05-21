import { z } from "zod";
import type { BrowserTool } from "../types";
import { sendSkillMessage } from "@/lib/skills/messages";
import type { InstalledSkill } from "@/lib/skills/types";

const parameters = z.object({
  name: z.string().describe("The name of the skill (e.g., 'inbox-closer')"),
  description: z.string().describe("A brief description of what the skill does and when to trigger it (max 1024 chars)"),
  body: z.string().describe("The full markdown instructions for the skill (the SKILL.md body without the frontmatter)"),
  references: z.array(z.object({
    path: z.string().describe("The relative path (e.g., 'references/style_guide.md')"),
    content: z.string().describe("The content of the reference file")
  })).optional().describe("Optional reference files to bundle with the skill")
});

type Input = z.infer<typeof parameters>;

type Output = 
  | { success: true; installed: InstalledSkill }
  | { error: string };

export const createSkillTool: BrowserTool<Input, Output> = {
  name: "create_skill",
  description: "Creates and installs a new skill directly into the browser's local skill registry. Use this when the user asks you to author a new skill for them, or after you have drafted a new skill using the skill-creator.",
  parameters,
  approval: { required: true },
  execute: async ({ name, description, body, references }) => {
    try {
      const res = await sendSkillMessage({ 
        type: "SKILL_CREATE", 
        name,
        description,
        body,
        references
      });
      return { success: true, installed: res.installed };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};
