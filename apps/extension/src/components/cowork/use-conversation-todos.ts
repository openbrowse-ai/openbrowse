import { useEffect, useState } from "react";
import { chatDb } from "@/lib/chat-db";
import type { TodoItem } from "@/lib/types";

/**
 * Live todos for a conversation. Polls the conversation row every 1s
 * (same cadence the home Progress card used). Returns [] when
 * `conversationId` is null or the conversation has no todos.
 */
export function useConversationTodos(conversationId: string | null): TodoItem[] {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  useEffect(() => {
    if (!conversationId) {
      setTodos([]);
      return;
    }
    let isMounted = true;
    const fetchTodos = async () => {
      const conv = await chatDb.getConversation(conversationId);
      if (isMounted && conv) setTodos(conv.todos || []);
    };
    fetchTodos();
    const interval = setInterval(fetchTodos, 1000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [conversationId]);
  return todos;
}
