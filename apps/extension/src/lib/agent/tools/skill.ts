import { z } from "zod";
import type { BrowserTool } from "../types";
import { sendSkillMessage } from "@/lib/skills/messages";

const parameters = z.object({
  name: z.string().describe("The name of the skill to load (e.g., 'react-best-practices')"),
});

type Input = z.infer<typeof parameters>;

type Output = 
  | { success: true; content: string }
  | { error: string };

export const skillTool: BrowserTool<Input, Output> = {
  name: "skill",
  description: "Loads a specialized skill's instructions into the conversation. Use this when a task matches one of the available skills.",
  parameters,
  execute: async ({ name }) => {
    try {
      const res = await sendSkillMessage({ type: "SKILL_GET_BODY", name });
      let content = res.body || "";
      
      if (res.hasScripts) {
        content += "\n\n> **Note:** This skill includes scripts that cannot be executed in OpenBrowse. Read their contents via `Read` (e.g. `Read({ file_path: \"/skills/<name>/<script>\" })`) if needed and accomplish the goal using available browser tools instead.";
      }
      
      return { success: true, content };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};
