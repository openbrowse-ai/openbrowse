import { z } from "zod";
import type { BrowserTool } from "../types";
import type { ApprovedPlan, TodoItem } from "../../types";

/**
 * Plan-mode entry point. The agent's first turn in Plan mode MUST call this
 * tool before any other approval-gated tool. The user reviews the plan
 * (sites + todos + goal) in the chat UI and clicks Approve or Make changes.
 *
 * On Approve: the SDK's approval flow lets `execute` run, we persist the
 * plan to the conversation, seed todos, and return `{ approved: true }`.
 * On Decline: the SDK never calls `execute`; the agent receives a
 * tool-result with declined semantics and is expected to revise.
 *
 * The agent re-calls `proposePlan` mid-task to extend the plan (new site,
 * flipping allowNetwork). The new plan replaces the old one wholesale.
 */
const parameters = z.object({
  goal: z
    .string()
    .min(1)
    .describe(
      "1-2 sentence summary of what the agent will accomplish. The user reads this — be specific and outcome-focused.",
    ),
  sites: z
    .array(z.string())
    .describe(
      "Origins (e.g. 'https://kilo.ai') the agent expects to touch. Be exhaustive. Pass full URLs OK — the tool normalizes to origin. The user can extend this mid-task by approving an off-plan call, but listing the right set up-front avoids interruptions.",
    ),
  todos: z
    .array(
      z.object({
        content: z
          .string()
          .min(1)
          .describe(
            "Imperative step description (e.g., 'Search for top 3 mechanical keyboards'). Seeds the todoWrite state.",
          ),
      }),
    )
    .describe(
      "Steps the agent will take. Seeds the per-conversation todo list — once approved you can update via todoWrite.",
    ),
  allowNetwork: z
    .boolean()
    .describe(
      "Default false. Set true ONLY if the task requires `executePython` with `allow_network: true` (calling external APIs). Most tasks don't.",
    ),
});

/** Public input type for proposePlan, consumed by the chat UI to type
 *  the streaming `part.input` it receives from the SDK. Exported so
 *  call sites narrow with a real type instead of `as never`. */
export type ProposePlanInput = z.infer<typeof parameters>;

type Input = ProposePlanInput;
// The "no session bound" runtime-contract violation is now thrown rather
// than returned, so the only success-path output is `{ approved: true }`.
type Output = { approved: true; plan: ApprovedPlan };

// Discriminated on `kind` so validation produces a precise per-arm
// error rather than a union-failure dump, and parsing skips the
// alternate arm once the discriminator is matched.
const planExtensionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("site"),
    site: z.string(),
    extendedAt: z.number(),
  }),
  z.object({
    kind: z.literal("network"),
    extendedAt: z.number(),
  }),
]);

const outputSchema = z.object({
  approved: z.literal(true),
  plan: z.object({
    goal: z.string(),
    sites: z.array(z.string()),
    allowNetwork: z.boolean(),
    approvedAt: z.number(),
    extensions: z.array(planExtensionSchema),
  }),
});

function normalizeOrigin(s: string): string {
  try {
    return new URL(s).origin;
  } catch {
    return s;
  }
}

export const proposePlanTool: BrowserTool<Input, Output> = {
  name: "proposePlan",
  description:
    "Propose a structured plan for the user to approve. ONLY callable in Plan mode. The user reviews the plan and clicks Approve or Make changes; on Approve, subsequent in-plan tool calls skip approval. Call this BEFORE any other gated tool when in Plan mode. Re-call to extend the plan (new site, flipping allowNetwork) — the new plan replaces the old wholesale.",
  parameters,
  outputSchema,
  approval: { required: true },
  execute: async (input, ctx) => {
    const cid = ctx.session?.conversationId;
    const setPlan = ctx.session?.setPlan;
    const setTodos = ctx.session?.setTodos;
    if (!cid || !setPlan) {
      // Runtime contract: the agent transport always binds a session
      // before invoking a tool. If we got here without one, something is
      // structurally broken — surface it as a real error so the SDK's
      // tool-error path runs (rather than silently returning a synthetic
      // `{ approved: false }` that callers would have to handle).
      throw new Error(
        "proposePlan requires an active conversation session; none was bound to this tool call.",
      );
    }

    const plan: ApprovedPlan = {
      goal: input.goal,
      sites: input.sites.map(normalizeOrigin),
      allowNetwork: input.allowNetwork,
      approvedAt: Date.now(),
      extensions: [],
    };
    await setPlan(plan);

    if (setTodos && input.todos.length > 0) {
      const now = Date.now();
      const seeded: TodoItem[] = input.todos.map((t) => ({
        id: crypto.randomUUID(),
        content: t.content,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }));
      await setTodos(seeded);
    }

    return { approved: true, plan };
  },
};
