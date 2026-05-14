import { z } from "zod";
import { memoryDb } from "../../memory-db";
import type { BrowserTool } from "../types";

const parameters = z.object({
  title: z.string().describe("The title of the memory to recall"),
  spaceId: z.string().optional().describe("Space ID the memory is scoped to. Omit for global."),
});

type Input = z.infer<typeof parameters>;
type Output = { found: boolean; content?: string; type?: string; domain?: string | null };

export const recallMemoryTool: BrowserTool<Input, Output> = {
  name: "recallMemory",
  description:
    "Read the full content of a saved memory by title. Use when you see a relevant memory in your index and need the full details.",
  parameters,
  execute: async (input) => {
    const { title, spaceId } = parameters.parse(input);
    const memory = await memoryDb.findByTitle(title, spaceId ?? null);
    if (!memory) {
      return { found: false };
    }
    return { found: true, content: memory.content, type: memory.type, domain: memory.domain };
  },
};
