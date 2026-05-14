import { z } from "zod";
import { memoryDb, type Memory } from "../../memory-db";
import type { BrowserTool } from "../types";

const parameters = z.object({
  title: z.string().describe("Short name for the memory (used as lookup key)"),
  description: z.string().describe("One-line summary shown in the memory index — be specific so future-you can judge relevance"),
  type: z.enum(["user", "feedback", "site", "reference"]).describe(
    "user = preferences/role, feedback = behavior corrections, site = per-domain knowledge, reference = where to find things"
  ),
  content: z.string().describe("The full memory content. For feedback types, structure as: rule/fact, then Why: and How to apply: lines"),
  domain: z.string().optional().describe("Domain this memory applies to (e.g. 'github.com'). Only for site type."),
  spaceId: z.string().optional().describe("Space ID to scope this memory to. Omit for global memories."),
});

type Input = z.infer<typeof parameters>;
type Output = { saved: true; id: string } | { saved: false; reason: string; existingContent: string };

export const saveMemoryTool: BrowserTool<Input, Output> = {
  name: "saveMemory",
  description:
    "Save a persistent memory that will be available in future conversations. Use this when the user asks you to remember something, corrects your behavior, or shares preferences/context worth retaining.",
  parameters,
  execute: async (input) => {
    const { title, description, type, content, domain, spaceId } = parameters.parse(input);
    const existing = await memoryDb.findByTitle(title, spaceId ?? null);

    if (existing) {
      return {
        saved: false,
        reason: "A memory with this title already exists. Use updateMemory to overwrite it.",
        existingContent: existing.content,
      };
    }

    const now = Date.now();
    const memory: Memory = {
      id: crypto.randomUUID(),
      title,
      description,
      type,
      content,
      domain: domain ?? null,
      spaceId: spaceId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await memoryDb.save(memory);
    return { saved: true, id: memory.id };
  },
};
