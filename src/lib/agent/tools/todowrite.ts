import { z } from "zod";
import { chatDb } from "@/lib/chat-db";
import { getAgentContext } from "../agent-transport";
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

export const todoWriteTool: BrowserTool<Input, Output> = {
  name: "todoWrite",
  description:
    "Proactively manage a structured task list to track progress during complex, multi-step tasks. Overwrites the current plan with the provided list. The list is preserved across conversation turns. RULES: At most one task can be 'in_progress' at a time. Mark tasks 'completed' immediately when done, do not batch completions.",
  parameters,
  execute: async (input) => {
    const { conversationId } = getAgentContext();
    if (!conversationId) {
      return { saved: false, reason: "No active conversation context to save todos against." };
    }

    const { todos: newTodosInput } = parameters.parse(input);

    const inProgressCount = newTodosInput.filter(t => t.status === "in_progress").length;
    if (inProgressCount > 1) {
      return { saved: false, reason: "Constraint violated: At most one task can be 'in_progress' at a time. Please update the statuses and try again." };
    }

    const conv = await chatDb.getConversation(conversationId);
    if (!conv) {
      return { saved: false, reason: "Active conversation not found in database." };
    }

    const now = Date.now();
    const existingTodos = conv.todos || [];
    
    // Map existing todos by content to preserve their IDs and createdAt times
    // (since we overwrite the whole list and don't want to re-create IDs every turn)
    const existingTodosMap = new Map<string, TodoItem>(
      existingTodos.map(t => [t.content, t])
    );

    const finalTodos: TodoItem[] = newTodosInput.map(item => {
      const existing = existingTodosMap.get(item.content);
      if (existing) {
        return {
          ...item,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: item.status !== existing.status ? now : existing.updatedAt,
        };
      }
      return {
        ...item,
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
    });

    await chatDb.updateConversation(conversationId, {
      todos: finalTodos,
      updatedAt: now,
    });

    return { saved: true };
  },
};
