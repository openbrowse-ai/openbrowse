import { z } from "zod";
import { memoryStore } from "../../memory/store";
import type { BrowserTool } from "../types";

const parameters = z.object({
  query: z
    .string()
    .describe(
      "Free-text query. Matches against memory titles, descriptions, aliases, and body content, ranked by relevance and boosted by how many other memories link to each hit.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Max results to return (default 5)."),
});

type Input = z.infer<typeof parameters>;

interface Hit {
  slug: string;
  title: string;
  description: string;
  type: string;
  scope: "user" | "space";
  domain: string | null;
  path: string;
  snippet: string;
}

interface Related {
  slug: string;
  title: string;
  description: string;
  scope: "user" | "space";
}

type Output =
  | { found: false }
  | { found: true; results: Hit[]; related: Related[] };

export const searchMemoryTool: BrowserTool<Input, Output> = {
  name: "searchMemory",
  description:
    "Search saved memories by keyword and get the most relevant ones back with a snippet and file path. Use this first when you don't know exactly where something is stored. Ranking combines keyword relevance (title > aliases > description > body) with a backlink boost (memories other memories link to rank higher). Also returns a `related` set of memories connected to the top hits via [[wikilinks]]. Read a full memory with the Read tool using the returned path.",
  parameters,
  execute: async (input, ctx) => {
    const { query, limit } = parameters.parse(input);
    const activeSpaceId = ctx.session?.spaceId ?? null;
    const { results, related } = await memoryStore.search(query, {
      activeSpaceId,
      limit,
    });
    if (results.length === 0) {
      return { found: false };
    }
    return {
      found: true,
      results: results.map((r) => ({
        slug: r.slug,
        title: r.title,
        description: r.description,
        type: r.type,
        scope: r.scope,
        domain: r.domain,
        path: r.path,
        snippet: r.snippet,
      })),
      related,
    };
  },
};
