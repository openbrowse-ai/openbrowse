import { CheckCircle2, Circle, XCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoItem } from "@/lib/types";
import { CoworkCard } from "./cowork-card";
import { ProgressEmptyArt } from "./empty-art";
import { useConversationTodos } from "./use-conversation-todos";

export function ProgressCard({ conversationId }: { conversationId: string }) {
  const todos = useConversationTodos(conversationId);
  return (
    <CoworkCard title="Progress">
      {todos.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-3.5 py-3 text-left">
          <ProgressEmptyArt />
          <p className="text-[13px] leading-snug text-muted-foreground">
            See task progress for longer tasks.
          </p>
        </div>
      ) : (
        <ul className="space-y-0.5 px-1.5 pb-1">
          {todos.map((todo) => (
            <li key={todo.id}>
              <TodoRow todo={todo} />
            </li>
          ))}
        </ul>
      )}
    </CoworkCard>
  );
}

export function TodoRow({ todo }: { todo: TodoItem }) {
  const isCompleted = todo.status === "completed";
  const isInProgress = todo.status === "in_progress";
  const isCancelled = todo.status === "cancelled";

  return (
    <div className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
      <span className="mt-0.5 shrink-0">
        {isCompleted ? (
          <CheckCircle2
            className="size-4 fill-blue-500 text-white dark:fill-blue-400"
            strokeWidth={2.5}
          />
        ) : isInProgress ? (
          <Loader2 className="size-4 animate-spin text-blue-500 dark:text-blue-400" />
        ) : isCancelled ? (
          <XCircle className="size-4 text-muted-foreground/60" />
        ) : (
          <Circle className="size-4 text-muted-foreground/40" />
        )}
      </span>
      <span
        className={cn(
          "text-sm leading-snug",
          isCompleted && "text-muted-foreground line-through",
          isCancelled && "text-muted-foreground/60 line-through",
          isInProgress && "font-medium text-foreground",
          !isCompleted && !isInProgress && !isCancelled && "text-foreground"
        )}
      >
        {todo.content}
      </span>
    </div>
  );
}
