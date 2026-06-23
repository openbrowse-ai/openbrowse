import { z } from "zod";
import { memoryDb, type Memory } from "../../memory-db";
import type { BrowserTool } from "../types";

const parameters = z.object({
  title: z.string().describe("Short name for the memory (used as lookup key)"),
  description: z
    .string()
    .describe(
      "One-line summary shown in the memory index — be specific so future-you can judge relevance",
    ),
  type: z
    .enum(["user", "feedback", "reference"])
    .describe(
      "user = preferences/role, feedback = behavior corrections, reference = where to find things. (Per-site knowledge belongs in a site skill — authored automatically by the background curator — not a memory.)",
    ),
  content: z
    .string()
    .describe(
      "The full memory content. For feedback types, structure as: rule/fact, then Why: and How to apply: lines",
    ),
  domain: z
    .string()
    .optional()
    .describe("Optional domain this memory applies to (e.g. 'github.com')."),
  scope: z
    .enum(["user", "space"])
    .optional()
    .describe(
      "Required when a space is active. 'user' = global memory (visible everywhere; use for facts about the user themself: identity, role, universal preferences). 'space' = scoped to the active space (visible only in this space; use for facts about the space's project: repos, tools, references, project-specific preferences). Outside any space, only 'user' is meaningful and you may omit this field.",
    ),
});

type Input = z.infer<typeof parameters>;
type Output =
  | {
      saved: true;
      id: string;
      scope: "user" | "space";
      spaceId: string | null;
    }
  | { saved: false; reason: string; existingContent?: string };

export const saveMemoryTool: BrowserTool<Input, Output> = {
  name: "saveMemory",
  description:
    "Save a persistent memory that will be available in future conversations. Use this when the user asks you to remember something, corrects your behavior, or shares preferences/context worth retaining. Inside a space, you must specify scope: 'user' (about the human) or 'space' (about this space's project).",
  parameters,
  execute: async (input, ctx) => {
    const { title, description, type, content, domain, scope } =
      parameters.parse(input);

    // The active space is read from the session, never from the model. The
    // model can only choose *whether* this memory is global or scoped — it
    // doesn't pick the spaceId itself.
    const activeSpaceId = ctx.session?.spaceId ?? null;

    // Resolve the scope according to the two-state contract:
    //
    //   active space | scope arg | result
    //   -------------+-----------+---------------------------------------
    //   none         | omitted   | save as global (the only legal scope)
    //   none         | "user"    | save as global
    //   none         | "space"   | error (no space to save into)
    //   active       | omitted   | error (must choose user vs. space)
    //   active       | "user"    | save as global
    //   active       | "space"   | save into the active space
    let resolvedSpaceId: string | null;
    if (activeSpaceId === null) {
      if (scope === "space") {
        return {
          saved: false,
          reason:
            "Cannot save with scope:'space' — no space is currently active.",
        };
      }
      // scope omitted or "user" → global.
      resolvedSpaceId = null;
    } else {
      if (scope === undefined) {
        return {
          saved: false,
          reason:
            "scope is required when a space is active. Pass scope:'user' for a fact about the human (identity, role, universal preferences) or scope:'space' for a fact about this space's project.",
        };
      }
      resolvedSpaceId = scope === "space" ? activeSpaceId : null;
    }

    const existing = await memoryDb.findByTitleInExactScope(
      title,
      resolvedSpaceId,
    );
    if (existing) {
      return {
        saved: false,
        reason:
          "A memory with this title already exists in this scope. Use updateMemory to overwrite it.",
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
      spaceId: resolvedSpaceId,
      createdAt: now,
      updatedAt: now,
    };

    await memoryDb.save(memory);
    return {
      saved: true,
      id: memory.id,
      scope: resolvedSpaceId === null ? "user" : "space",
      spaceId: resolvedSpaceId,
    };
  },
};
