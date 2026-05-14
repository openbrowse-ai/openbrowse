import { z } from "zod";
import type { BrowserTool } from "../types";
import { sendSkillMessage } from "@/lib/skills/messages";

const parameters = z.object({
  path: z.string().describe("The path of the file to read from OPFS (e.g., 'skills/react-best-practices/references/patterns.md')"),
});

type Input = z.infer<typeof parameters>;

type Output = 
  | { success: true; content: string }
  | { error: string };

export const readOpfsFileTool: BrowserTool<Input, Output> = {
  name: "read_opfs_file",
  description: "Reads a file from the extension's OPFS storage. Useful for reading reference files bundled with skills.",
  parameters,
  execute: async ({ path }) => {
    try {
      const res = await sendSkillMessage({ type: "SKILL_READ_OPFS_FILE", path });
      return { success: true, content: res.content || "" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};
