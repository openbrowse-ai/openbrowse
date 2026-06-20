import { z } from "zod";
import type { BrowserTool } from "../types";
import { sendSkillMessage } from "@/lib/skills/messages";

const parameters = z.object({
  domain: z
    .string()
    .describe("The site skill to delete — its domain name (e.g. 'linkedin.com')."),
});

type Input = z.infer<typeof parameters>;
type Output = { success: true } | { error: string };

export const deleteSiteSkillTool: BrowserTool<Input, Output> = {
  name: "delete_site_skill",
  description:
    "Delete a SITE SKILL (the per-domain script/knowledge store) when it is obsolete or fundamentally misconceived. Runs WITHOUT approval. Refuses to delete regular/user-installed skills — only `kind: site` skills. Prefer fixing a deficient skill with patch_site_skill over deleting it.",
  parameters,
  execute: async ({ domain }) => {
    try {
      await sendSkillMessage({ type: "SKILL_DELETE_SITE", name: domain });
      return { success: true };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};
