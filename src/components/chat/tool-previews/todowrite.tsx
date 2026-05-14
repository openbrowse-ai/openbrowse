import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "../../ai-elements/task";
import { registerToolPreview } from "./registry";
import type { TodoItem } from "@/lib/types";

registerToolPreview("todoWrite", (args) => {
  const todos = (args.todos as TodoItem[]) || [];
  if (todos.length === 0) {
    return (
      <div className="px-4 py-3 bg-muted/50 rounded-lg text-sm text-muted-foreground italic">
        Plan cleared.
      </div>
    );
  }

  const completedCount = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.some((t) => t.status === "in_progress");

  return (
    <div className="my-2">
      <Task defaultOpen={inProgress}>
        <TaskTrigger title={`Plan · ${completedCount}/${todos.length} complete`} />
        <TaskContent>
          {todos.map((todo, idx) => (
            <TaskItem
              key={todo.id || idx}
              status={todo.status}
              className={todo.priority === "high" ? "font-medium" : ""}
            >
              {todo.content}
            </TaskItem>
          ))}
        </TaskContent>
      </Task>
    </div>
  );
});