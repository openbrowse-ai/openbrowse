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
      try {
        const conv = await chatDb.getConversation(conversationId);
        // Clear stale todos when the conversation is gone (e.g. deleted in
        // another window) so the old list doesn't leak into the UI.
        if (isMounted) setTodos(conv?.todos ?? []);
      } catch {
        // Transient read failure; drop to a safe empty state and let the
        // next poll tick retry. Swallow so the rejection doesn't escape the
        // bare call / setInterval loop.
        if (isMounted) setTodos([]);
      }
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
