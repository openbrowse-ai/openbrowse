import { z } from "zod";
import type { BrowserTool } from "../types";
import { taskDb } from "@/lib/schedule/task-db";
import { formatSchedule } from "@/lib/schedule/format";

const parameters = z.object({});

type Input = z.infer<typeof parameters>;
interface TaskSummary {
  id: string;
  name: string;
  description: string;
  schedule: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunStatus: string | null;
}
type Output = { tasks: TaskSummary[] };

export const listScheduledTasksTool: BrowserTool<Input, Output> = {
  name: "list_scheduled_tasks",
  description:
    "List all scheduled tasks with their schedules, whether they're enabled, when they next run, and their last run status.",
  parameters,
  execute: async () => {
    const tasks = await taskDb.list();
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        schedule: formatSchedule(t.schedule),
        enabled: t.enabled,
        nextRunAt: t.nextRunAt ?? null,
        lastRunStatus: t.lastRunStatus ?? null,
      })),
    };
  },
};
