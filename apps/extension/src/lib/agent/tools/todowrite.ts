import { z } from "zod";
import type { BrowserTool } from "../types";
import type { TodoItem } from "../../types";

const todoSchema = z.object({
  content: z.string().describe("Imperative task description (e.g., 'Search for top 3 mechanical keyboards')"),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

const parameters = z.object({
  todos: z.array(todoSchema).describe("The complete, updated list of tasks. This entirely replaces the current plan. Provide the FULL list every time."),
});

type Input = z.infer<typeof parameters>;
const outputSchema = z.union([
  z.object({ saved: z.literal(true) }),
  z.object({ saved: z.literal(false), reason: z.string() }),
]);
type Output = z.infer<typeof outputSchema>;

export const todoWriteTool: BrowserTool<Input, Output> = {
  name: "todoWrite",
  description:
    "Proactively manage a structured task list to track progress during complex, multi-step tasks. Overwrites the current plan with the provided list. The list is preserved across conversation turns. RULES: At most one task can be 'in_progress' at a time. Mark tasks 'completed' immediately when done, do not batch completions.",
  parameters,
  outputSchema,
  execute: async (input, ctx) => {
    if (!ctx.session?.getTodos || !ctx.session?.setTodos) {
      return { saved: false, reason: "No active session context to save todos against." };
    }

    const { todos: newTodosInput } = parameters.parse(input);

    const inProgressCount = newTodosInput.filter(t => t.status === "in_progress").length;
    if (inProgressCount > 1) {
      return { saved: false, reason: "Constraint violated: At most one task can be 'in_progress' at a time. Please update the statuses and try again." };
    }

    const existingTodos = await ctx.session.getTodos();

    // Re-use IDs for existing tasks, generate new IDs for new tasks
    // (since we overwrite the whole list and don't want to re-create IDs every turn)
    const existingTodosMap = new Map<string, TodoItem>(
      existingTodos.map(t => [t.content, t])
    );

    const finalTodos: TodoItem[] = newTodosInput.map(item => {
      const existing = existingTodosMap.get(item.content);
      if (existing) {
        return {
          ...existing,
          ...item,
          updatedAt: Date.now()
        };
      } else {
        const now = Date.now();
        return {
          ...item,
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        };
      }
    });

    await ctx.session.setTodos(finalTodos);

    return { saved: true };
  },
};
