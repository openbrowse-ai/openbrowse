import { z } from "zod";
import { memoryDb } from "../../memory-db";
import type { BrowserTool } from "../types";

const parameters = z.object({
  title: z.string().describe("The title of the memory to recall"),
});

type Input = z.infer<typeof parameters>;

interface RecallMatch {
  content: string;
  type: string;
  domain: string | null;
  scope: "user" | "space";
}

type Output =
  | { found: false }
  | { found: true; matches: RecallMatch[] };

export const recallMemoryTool: BrowserTool<Input, Output> = {
  name: "recallMemory",
  description:
    "Read the full content of saved memories by title. The lookup spans the active space's memories plus globals. When the same title exists in both scopes (e.g. a global 'github-conventions' and a space-scoped 'github-conventions'), both are returned in `matches` with their `scope` so you can use whichever is relevant — or both. The shape is always an array; the common case is `matches.length === 1`.",
  parameters,
  execute: async (input, ctx) => {
    const { title } = parameters.parse(input);
    const activeSpaceId = ctx.session?.spaceId ?? null;
    const memories = await memoryDb.findAllByTitle(title, activeSpaceId);
    if (memories.length === 0) {
      return { found: false };
    }
    return {
      found: true,
      matches: memories.map((m) => ({
        content: m.content,
        type: m.type,
        domain: m.domain,
        scope: m.spaceId === null ? ("user" as const) : ("space" as const),
      })),
    };
  },
};
