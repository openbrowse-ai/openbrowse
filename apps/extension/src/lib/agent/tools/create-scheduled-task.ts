import { z } from "zod";
import type { BrowserTool } from "../types";
import { taskDb } from "@/lib/schedule/task-db";
import type { Schedule } from "@/lib/schedule/types";
import { storage } from "@/lib/storage";

/**
 * Tool-facing schedule spec. Recurring kinds mirror the `Schedule` union.
 * For one-time events the agent may pass EITHER an absolute ISO timestamp
 * (`at`, e.g. "tomorrow 3pm" resolved by the model) OR a relative
 * `inMinutes` (e.g. "in 20 minutes") — the tool computes the absolute time
 * so the model doesn't need to know the wall clock.
 */
export const scheduleInputSchema = z.union([
  z.object({ kind: z.literal("hourly"), minute: z.number().int().min(0).max(59) }),
  z.object({
    kind: z.literal("daily"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("weekdays"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("weekly"),
    weekday: z
      .number()
      .int()
      .min(0)
      .max(6)
      .describe("0=Sunday, 1=Monday, … 6=Saturday"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("once"),
    at: z
      .string()
      .optional()
      .describe("Absolute time, ISO 8601 (e.g. '2026-06-03T15:00'). Use for 'tomorrow at 3pm'."),
    inMinutes: z
      .number()
      .positive()
      .optional()
      .describe("Relative offset in minutes from now. Use for 'in 20 minutes'."),
  }),
]);

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

/** Resolve the tool-facing schedule spec into a concrete `Schedule`. */
export function resolveScheduleInput(
  input: ScheduleInput,
  now: number = Date.now(),
): Schedule {
  if (input.kind === "once") {
    let at: number;
    if (typeof input.inMinutes === "number") {
      at = now + input.inMinutes * 60_000;
    } else if (input.at) {
      const parsed = new Date(input.at).getTime();
      if (Number.isNaN(parsed)) {
        throw new Error(`Invalid 'at' timestamp: ${input.at}`);
      }
      at = parsed;
    } else {
      throw new Error("once schedule requires either 'at' or 'inMinutes'");
    }
    return { kind: "once", at };
  }
  return input;
}

const parameters = z.object({
  name: z.string().describe("Short name for the task (e.g. 'daily-briefing')."),
  description: z
    .string()
    .optional()
    .describe("One-line summary of what the task does."),
  prompt: z
    .string()
    .describe("The instruction the agent runs each time the task fires."),
  agentModel: z
    .string()
    .optional()
    .describe(
      "Model as '<providerId>:<modelId>'. Omit to use the current agent model.",
    ),
  schedule: scheduleInputSchema,
  autoApprove: z
    .boolean()
    .optional()
    .describe(
      "Auto-approve tool actions that normally need confirmation (the task runs headless with no human). Default false.",
    ),
});

type Input = z.infer<typeof parameters>;
type Output =
  | { created: true; id: string; nextRunAt: number | null }
  | { created: false; reason: string };

export const createScheduledTaskTool: BrowserTool<Input, Output> = {
  name: "create_scheduled_task",
  description:
    "Create a scheduled task that runs automatically — either on a recurring schedule (hourly/daily/weekdays/weekly) or as a one-time future event. Gather the prompt and the schedule from the user first. Scheduled tasks run in a dedicated browser window while Chrome is open.",
  parameters,
  execute: async (input) => {
    const { name, description, prompt, agentModel, schedule, autoApprove } =
      parameters.parse(input);
    try {
      let model = agentModel;
      if (!model) {
        const agentSettings = await storage.getAgentSettings();
        model = agentSettings.agentModel;
      }
      if (!model) {
        return {
          created: false,
          reason:
            "No model specified and no current agent model is configured. Ask the user to pick a model.",
        };
      }
      const resolved = resolveScheduleInput(schedule);
      const task = await taskDb.create({
        name,
        description: description ?? "",
        prompt,
        agentModel: model,
        schedule: resolved,
        enabled: true,
        needsBrowser: true,
        autoApprove: autoApprove ?? false,
      });
      return { created: true, id: task.id, nextRunAt: task.nextRunAt ?? null };
    } catch (e) {
      return { created: false, reason: (e as Error).message };
    }
  },
};
