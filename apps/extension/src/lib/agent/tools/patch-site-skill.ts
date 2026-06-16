import { z } from "zod";
import type { BrowserTool } from "../types";
import { sendSkillMessage } from "@/lib/skills/messages";
import type { InstalledSkill } from "@/lib/skills/types";

const parameters = z.object({
  domain: z
    .string()
    .describe(
      "The site's registrable domain — the site skill's name (e.g. 'linkedin.com'). Created if it doesn't exist.",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "Replace the skill's description (when to load it; max 1024 chars). Omit to leave unchanged.",
    ),
  body: z
    .string()
    .optional()
    .describe(
      "Replace the SKILL.md body (markdown, no frontmatter): durable site notes + a script catalog (filename, purpose, args, returns for each script). Omit to leave unchanged.",
    ),
  upsertScripts: z
    .array(
      z.object({
        path: z
          .string()
          .describe("Script filename, e.g. 'list-recent-posts.js'."),
        content: z
          .string()
          .describe(
            "JS function body — executeOnPage `code` contract: DOM access, read `args`, `return` JSON-serializable result.",
          ),
      }),
    )
    .optional()
    .describe("Create-or-replace these scripts. Other scripts are untouched."),
  deleteScripts: z
    .array(z.string())
    .optional()
    .describe("Remove these script filenames. Other scripts are untouched."),
});

type Input = z.infer<typeof parameters>;
type Output =
  | { success: true; installed: InstalledSkill }
  | { error: string };

export const patchSiteSkillTool: BrowserTool<Input, Output> = {
  name: "patch_site_skill",
  description:
    "Patch a SITE SKILL (per-domain durable notes + reusable page scripts) at script granularity. Runs WITHOUT approval. Unlike a full overwrite, named scripts are upserted/deleted and everything else is preserved — so you never need to resend the whole script set. Foreground: use to SELF-HEAL a script you just ran via scriptRef and judged deficient. (New skills are normally authored by the background curator after the turn ends.)",
  parameters,
  execute: async ({
    domain,
    description,
    body,
    upsertScripts,
    deleteScripts,
  }) => {
    try {
      const res = await sendSkillMessage({
        type: "SKILL_PATCH_SITE",
        name: domain,
        description,
        body,
        upsertScripts,
        deleteScripts,
      });
      return { success: true, installed: res.installed };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};
