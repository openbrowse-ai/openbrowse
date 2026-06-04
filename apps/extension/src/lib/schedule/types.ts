// src/lib/schedule/types.ts

/** Discriminated recurrence rule. All clock fields are LOCAL time. */
export type Schedule =
  | { kind: "manual" }
  | { kind: "once"; at: number } // absolute epoch ms
  | { kind: "hourly"; minute: number } // 0-59
  | { kind: "daily"; hour: number; minute: number } // hour 0-23
  | { kind: "weekdays"; hour: number; minute: number } // Mon-Fri
  | { kind: "weekly"; weekday: number; hour: number; minute: number }; // weekday 0=Sun..6=Sat

export type ScheduleKind = Schedule["kind"];

export type ScheduledRunStatus = "success" | "error" | "running";

export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  prompt: string;
  /** "<providerId>:<modelId>" — same format as AgentSettings.agentModel. */
  agentModel: string;
  schedule: Schedule;
  enabled: boolean;
  /**
   * Reserved flag for tasks that require browser/DOM access during the run.
   * Runs always execute in the background in a pinned home.html tab (via
   * ScheduledRunHost); no separate browser window is opened. Default true.
   */
  needsBrowser: boolean;
  /**
   * When true, the headless run auto-approves tool actions that normally
   * require human confirmation (the task runs with no human present).
   * When false (default), approval-gated tools are omitted from the run.
   */
  autoApprove: boolean;
  /** Set when the task was created from an existing conversation. */
  sourceConversationId?: string;
  /** Parent "task" conversation that owns this task's runs (lazy-created). */
  taskConversationId?: string;
  createdAt: number;
  updatedAt: number;

  // Runtime bookkeeping (persisted; the SW is torn down between alarms).
  lastRunAt?: number;
  lastRunStatus?: ScheduledRunStatus;
  lastRunConversationId?: string;
  lastRunError?: string;
  /** Absolute epoch ms of the next fire; null when manual or consumed once. */
  nextRunAt?: number | null;
}
