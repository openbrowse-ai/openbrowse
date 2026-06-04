import { z } from "zod";
import type { BrowserTool } from "../types";
import { taskDb } from "@/lib/schedule/task-db";
import type { ScheduledTaskRow } from "@/lib/chat-db";
import {
  resolveScheduleInput,
  type ScheduleInput,
} from "./create-scheduled-task";
import { scheduleInputSchema } from "./create-scheduled-task";

const parameters = z.object({
  id: z.string().describe("The id of the scheduled task to update."),
  name: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional().describe("New instruction for the task."),
  schedule: scheduleInputSchema.optional().describe("New schedule."),
  enabled: z
    .boolean()
    .optional()
    .describe("Set false to pause the task, true to resume it."),
  autoApprove: z
    .boolean()
    .optional()
    .describe(
      "Auto-approve tool actions that normally need confirmation during the headless run.",
    ),
});

type Input = z.infer<typeof parameters>;
type Output = { updated: true } | { updated: false; reason: string };

export const updateScheduledTaskTool: BrowserTool<Input, Output> = {
  name: "update_scheduled_task",
  description:
    "Modify an existing scheduled task: change its prompt or schedule, rename it, or pause/resume it (set enabled). Use list_scheduled_tasks first to get the task id.",
  parameters,
  execute: async (input) => {
    const { id, name, description, prompt, schedule, enabled, autoApprove } =
      parameters.parse(input);
    try {
      const existing = await taskDb.get(id);
      if (!existing) {
        return { updated: false, reason: `No scheduled task with id ${id}.` };
      }
      const patch: Partial<ScheduledTaskRow> = {};
      if (name !== undefined) patch.name = name;
      if (description !== undefined) patch.description = description;
      if (prompt !== undefined) patch.prompt = prompt;
      if (enabled !== undefined) patch.enabled = enabled;
      if (autoApprove !== undefined) patch.autoApprove = autoApprove;
      if (schedule !== undefined) {
        patch.schedule = resolveScheduleInput(schedule as ScheduleInput);
        // nextRunAt is recomputed by taskDb.update when schedule changes.
      }
      await taskDb.update(id, patch);
      return { updated: true };
    } catch (e) {
      return { updated: false, reason: (e as Error).message };
    }
  },
};
