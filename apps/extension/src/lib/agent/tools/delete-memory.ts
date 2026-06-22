import { z } from "zod";
import { memoryDb } from "../../memory-db";
import type { BrowserTool } from "../types";

const parameters = z.object({
  title: z.string().describe("The title of the memory to delete"),
  scope: z
    .enum(["user", "space"])
    .optional()
    .describe(
      "Required only when both a global and a space-scoped memory share this title. Pass 'user' to delete the global one or 'space' to delete the active space's one. When only one match exists, omit this field.",
    ),
});

type Input = z.infer<typeof parameters>;

interface AmbiguousMatch {
  scope: "user" | "space";
  description: string;
}

type Output =
  | { deleted: true; scope: "user" | "space" }
  | { deleted: false; reason: string; matches?: AmbiguousMatch[] };

export const deleteMemoryTool: BrowserTool<Input, Output> = {
  name: "deleteMemory",
  description:
    "Delete a previously saved memory. Use when the user asks to forget something or a memory is outdated. Lookup spans the active space's memories plus globals. When a title exists in both scopes, you must pass `scope` to disambiguate; otherwise omit it.",
  parameters,
  execute: async (input, ctx) => {
    const { title, scope } = parameters.parse(input);
    const activeSpaceId = ctx.session?.spaceId ?? null;
    const matches = await memoryDb.findAllByTitle(title, activeSpaceId);

    if (matches.length === 0) {
      return {
        deleted: false,
        reason: "No memory found with that title in this scope.",
      };
    }

    let target = matches.length === 1 ? matches[0] : undefined;
    if (matches.length > 1) {
      if (scope === undefined) {
        return {
          deleted: false,
          reason:
            "Multiple memories share this title. Pass scope:'user' to delete the global one or scope:'space' to delete this space's one.",
          matches: matches.map((m) => ({
            scope: m.spaceId === null ? ("user" as const) : ("space" as const),
            description: m.description,
          })),
        };
      }
      const wantSpaceScoped = scope === "space";
      target = matches.find((m) =>
        wantSpaceScoped ? m.spaceId !== null : m.spaceId === null,
      );
      if (!target) {
        return {
          deleted: false,
          reason: `No memory titled '${title}' found with scope:'${scope}'.`,
        };
      }
    }

    // `target` is guaranteed defined by this point: either matches.length===1
    // produced it, or the matches.length>1 branch resolved a pick or returned.
    const picked = target!;
    await memoryDb.delete(picked.id);
    return {
      deleted: true,
      scope: picked.spaceId === null ? "user" : "space",
    };
  },
};
