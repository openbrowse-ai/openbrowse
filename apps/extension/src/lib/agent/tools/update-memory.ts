import { z } from "zod";
import { memoryDb, type Memory } from "../../memory-db";
import type { BrowserTool } from "../types";
import { buildMemoryDiff } from "./memory-diff";

const parameters = z.object({
  title: z.string().describe("The title of the existing memory to update"),
  description: z
    .string()
    .optional()
    .describe("New description. If omitted, keeps existing."),
  content: z
    .string()
    .describe("The new content to replace the existing memory content"),
  domain: z
    .string()
    .optional()
    .describe("Updated domain. If omitted, keeps existing."),
  scope: z
    .enum(["user", "space"])
    .optional()
    .describe(
      "Required only when both a global and a space-scoped memory share this title (you'll see both in the index). Pass 'user' to update the global one or 'space' to update the active space's one. When only one match exists, omit this field — scope is preserved automatically.",
    ),
});

type Input = z.infer<typeof parameters>;

interface AmbiguousMatch {
  scope: "user" | "space";
  description: string;
}

type Output =
  | {
      updated: true;
      id: string;
      diffPreview: string;
      scope: "user" | "space";
    }
  | { updated: false; reason: string; matches?: AmbiguousMatch[] };

export const updateMemoryTool: BrowserTool<Input, Output> = {
  name: "updateMemory",
  description:
    "Update an existing memory's content. Requires user approval before executing. Lookup spans the active space's memories plus globals. When a title exists in both scopes, you must pass `scope` to disambiguate; otherwise omit it. Scope is preserved across updates — a global memory stays global, a space-scoped memory stays in its space.",
  parameters,
  approval: { required: true },
  execute: async (input, ctx) => {
    const { title, description, content, domain, scope } =
      parameters.parse(input);
    const activeSpaceId = ctx.session?.spaceId ?? null;
    const matches = await memoryDb.findAllByTitle(title, activeSpaceId);

    if (matches.length === 0) {
      return {
        updated: false,
        reason:
          "No memory found with that title in this scope. Use saveMemory to create a new one.",
      };
    }

    let target: Memory;
    if (matches.length === 1) {
      // Unambiguous — ignore any scope arg the model passed.
      target = matches[0];
    } else {
      // Multiple matches — require disambiguation.
      if (scope === undefined) {
        return {
          updated: false,
          reason:
            "Multiple memories share this title. Pass scope:'user' to update the global one or scope:'space' to update this space's one.",
          matches: matches.map((m) => ({
            scope: m.spaceId === null ? ("user" as const) : ("space" as const),
            description: m.description,
          })),
        };
      }
      const wantSpaceScoped = scope === "space";
      const picked = matches.find((m) =>
        wantSpaceScoped ? m.spaceId !== null : m.spaceId === null,
      );
      if (!picked) {
        return {
          updated: false,
          reason: `No memory titled '${title}' found with scope:'${scope}'.`,
        };
      }
      target = picked;
    }

    // Compute the diff here so the result stays lightweight — we avoid echoing
    // the full old + new memory bodies back into the conversation transcript.
    const diffPreview = buildMemoryDiff(target.content, content);

    const memory: Memory = {
      ...target,
      content,
      description: description ?? target.description,
      domain: domain !== undefined ? (domain ?? null) : target.domain,
      updatedAt: Date.now(),
      // spaceId intentionally preserved from `target`. Updates never move a
      // memory between scopes — that's a different operation (delete + save).
    };

    await memoryDb.save(memory);
    return {
      updated: true,
      id: memory.id,
      diffPreview,
      scope: memory.spaceId === null ? "user" : "space",
    };
  },
};
