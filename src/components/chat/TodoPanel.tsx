import { useEffect, useState } from "react";
import { chatDb } from "@/lib/chat-db";
import type { TodoItem } from "@/lib/types";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "../ai-elements/chain-of-thought";
import { Shimmer } from "../ai-elements/shimmer";

interface TodoPanelProps {
  conversationId: string | null;
}

export function TodoPanel({ conversationId }: TodoPanelProps) {
  const [todos, setTodos] = useState<TodoItem[]>([]);

  useEffect(() => {
    if (!conversationId) {
      setTodos([]);
      return;
    }

    let isMounted = true;
    
    // Initial fetch
    chatDb.getConversation(conversationId).then(conv => {
      if (isMounted && conv) {
        setTodos(conv.todos || []);
      }
    });

    // Poll for updates since IndexedDB doesn't have native reactivity
    // in this app's architecture for non-message fields yet
    const interval = setInterval(async () => {
      const conv = await chatDb.getConversation(conversationId);
      if (isMounted && conv) {
        setTodos(conv.todos || []);
      }
    }, 1000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [conversationId]);

  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === "completed").length;
  const inProgress = todos.find(t => t.status === "in_progress");
  const headerText = inProgress 
    ? `Plan (${completed}/${todos.length}) — ${inProgress.content}`
    : `Plan (${completed}/${todos.length})`;

  // Map our domain statuses to ChainOfThought statuses
  const mapStatus = (status: string) => {
    switch (status) {
      case "in_progress": return "active";
      case "completed": return "complete";
      case "cancelled": return "cancelled";
      default: return "pending";
    }
  };

  return (
    <div className="border-b border-border bg-muted/20 px-4 py-2">
      <ChainOfThought defaultOpen={false}>
        <ChainOfThoughtHeader>
          {inProgress ? (
            <Shimmer duration={3} spread={1.5} className="font-medium text-blue-500/90 dark:text-blue-400/90">
              {headerText}
            </Shimmer>
          ) : (
            headerText
          )}
        </ChainOfThoughtHeader>
        <ChainOfThoughtContent>
          {todos.map((todo, idx) => (
            <ChainOfThoughtStep
              key={todo.id || idx}
              label={todo.content}
              status={mapStatus(todo.status)}
            />
          ))}
        </ChainOfThoughtContent>
      </ChainOfThought>
    </div>
  );
}