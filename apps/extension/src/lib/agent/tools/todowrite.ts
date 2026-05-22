import { z } from "zod";
import { chatDb } from "@/lib/chat-db";
import type { BrowserTool } from "../types";
import type { TodoItem } from "@/lib/types";

const todoSchema = z.object({
  content: z.string().describe("Imperative task description (e.g., 'Search for top 3 mechanical keyboards')"),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

const parameters = z.object({
  todos: z.array(todoSchema).describe("The complete, updated list of tasks. This entirely replaces the current plan. Provide the FULL list every time."),
});

type Input = z.infer<typeof parameters>;
type Output = { saved: true } | { saved: false; reason: string };

export function createTodoWriteTool(
  conversationId: string | null,
): BrowserTool<Input, Output> {
  return {
    name: "todoWrite",
    description:
      "Proactively manage a structured task list to track progress during complex, multi-step tasks. Overwrites the current plan with the provided list. The list is preserved across conversation turns. RULES: At most one task can be 'in_progress' at a time. Mark tasks 'completed' immediately when done, do not batch completions.",
    parameters,
    execute: async (input) => {
      if (!conversationId) {
        return {
          saved: false,
          reason: "No active conversation context to save todos against.",
        };
      }

      const now = Date.now();
      const todosToSave: TodoItem[] = input.todos.map((item) => {
        return {
          ...item,
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        };
      });

      await chatDb.updateConversation(conversationId, { todos: todosToSave, updatedAt: now });
      return { saved: true };
    },
  };
}
