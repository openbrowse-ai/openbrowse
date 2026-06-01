import { z } from "zod";
import { memoryDb, type Memory } from "../../memory-db";
import type { BrowserTool } from "../types";

const parameters = z.object({
  title: z.string().describe("The title of the existing memory to update"),
  description: z.string().optional().describe("New description. If omitted, keeps existing."),
  content: z.string().describe("The new content to replace the existing memory content"),
  domain: z.string().optional().describe("Updated domain. If omitted, keeps existing."),
  spaceId: z.string().optional().describe("Space ID the memory is scoped to. Omit for global."),
});

type Input = z.infer<typeof parameters>;
type Output =
  | { updated: true; id: string; oldContent: string; newContent: string }
  | { updated: false; reason: string };

export const updateMemoryTool: BrowserTool<Input, Output> = {
  name: "updateMemory",
  description:
    "Update an existing memory's content. Requires user approval before executing. Use when you need to modify a previously saved memory.",
  parameters,
  approval: { required: true },
  execute: async (input) => {
    const { title, description, content, domain, spaceId } = parameters.parse(input);
    const existing = await memoryDb.findByTitle(title, spaceId ?? null);

    if (!existing) {
      return { updated: false, reason: "No memory found with that title. Use saveMemory to create a new one." };
    }

    const memory: Memory = {
      ...existing,
      content,
      description: description ?? existing.description,
      domain: domain !== undefined ? (domain ?? null) : existing.domain,
      updatedAt: Date.now(),
    };

    await memoryDb.save(memory);
    return {
      updated: true,
      id: memory.id,
      oldContent: existing.content,
      newContent: content,
    };
  },
};
