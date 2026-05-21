import { z } from "zod";
import { memoryDb } from "../../memory-db";
import type { BrowserTool } from "../types";

const parameters = z.object({
  title: z.string().describe("The title of the memory to delete"),
  spaceId: z.string().optional().describe("Space ID the memory is scoped to. Omit for global."),
});

type Input = z.infer<typeof parameters>;
type Output = { deleted: boolean; reason?: string };

export const deleteMemoryTool: BrowserTool<Input, Output> = {
  name: "deleteMemory",
  description:
    "Delete a previously saved memory. Use when the user asks to forget something or a memory is outdated.",
  parameters,
  execute: async (input) => {
    const { title, spaceId } = parameters.parse(input);
    const existing = await memoryDb.findByTitle(title, spaceId ?? null);
    if (!existing) {
      return { deleted: false, reason: "No memory found with that title" };
    }
    await memoryDb.delete(existing.id);
    return { deleted: true };
  },
};
