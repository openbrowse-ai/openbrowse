// src/lib/agent/tools/__tests__/scheduled-task-tools.test.ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import { taskDb } from "@/lib/schedule/task-db";
import {
  createScheduledTaskTool,
  resolveScheduleInput,
} from "../create-scheduled-task";
import { listScheduledTasksTool } from "../list-scheduled-tasks";
import { updateScheduledTaskTool } from "../update-scheduled-task";
import { storage } from "@/lib/storage";

// Tools don't read ctx; pass a minimal stand-in.
const ctx = {} as never;

beforeEach(() => {
  indexedDB = new IDBFactory();
  chatDb._resetForTests();
  vi.restoreAllMocks();
});

describe("resolveScheduleInput", () => {
  it("passes recurring schedules through unchanged", () => {
    expect(
      resolveScheduleInput({ kind: "daily", hour: 9, minute: 0 }),
    ).toEqual({ kind: "daily", hour: 9, minute: 0 });
  });

  it("once: computes absolute time from inMinutes", () => {
    const now = 1_000_000;
    const out = resolveScheduleInput({ kind: "once", inMinutes: 20 }, now);
    expect(out).toEqual({ kind: "once", at: now + 20 * 60_000 });
  });

  it("once: parses an absolute ISO 'at'", () => {
    const iso = "2026-06-03T15:00:00.000Z";
    const out = resolveScheduleInput({ kind: "once", at: iso });
    expect(out).toEqual({ kind: "once", at: new Date(iso).getTime() });
  });

  it("once: throws when neither at nor inMinutes given", () => {
    expect(() => resolveScheduleInput({ kind: "once" })).toThrow();
  });

  it("once: throws on an invalid at", () => {
    expect(() =>
      resolveScheduleInput({ kind: "once", at: "not-a-date" }),
    ).toThrow();
  });

  it("once: rejects ambiguous input (both at and inMinutes)", () => {
    expect(() =>
      resolveScheduleInput({
        kind: "once",
        at: "2030-01-01T00:00:00Z",
        inMinutes: 20,
      }),
    ).toThrow(/exactly one of 'at' or 'inMinutes'/);
  });
});

describe("create_scheduled_task", () => {
  it("creates a recurring task with an explicit model", async () => {
    const res = await createScheduledTaskTool.execute(
      {
        name: "brief",
        description: "morning digest",
        prompt: "Summarize AI news",
        agentModel: "openai:gpt-4o",
        schedule: { kind: "daily", hour: 9, minute: 0 },
      },
      ctx,
    );
    expect(res.created).toBe(true);
    if (!res.created) throw new Error("expected created");
    const row = await taskDb.get(res.id);
    expect(row?.name).toBe("brief");
    expect(row?.agentModel).toBe("openai:gpt-4o");
    expect(row?.schedule).toEqual({ kind: "daily", hour: 9, minute: 0 });
    expect(row?.enabled).toBe(true);
    expect(row?.needsBrowser).toBe(true);
    expect(row?.autoApprove).toBe(false);
    expect(res.nextRunAt).toBeTypeOf("number");
  });

  it("sets autoApprove when requested", async () => {
    const res = await createScheduledTaskTool.execute(
      {
        name: "t",
        prompt: "p",
        agentModel: "openai:gpt-4o",
        schedule: { kind: "daily", hour: 9, minute: 0 },
        autoApprove: true,
      },
      ctx,
    );
    expect(res.created).toBe(true);
    if (!res.created) throw new Error("expected created");
    expect((await taskDb.get(res.id))?.autoApprove).toBe(true);
  });

  it("defaults to the current agent model when omitted", async () => {
    vi.spyOn(storage, "getAgentSettings").mockResolvedValue({
      agentModel: "anthropic:claude-sonnet-4-6",
    });
    const res = await createScheduledTaskTool.execute(
      {
        name: "t",
        prompt: "do",
        schedule: { kind: "once", inMinutes: 30 },
      },
      ctx,
    );
    expect(res.created).toBe(true);
    if (!res.created) throw new Error("expected created");
    const row = await taskDb.get(res.id);
    expect(row?.agentModel).toBe("anthropic:claude-sonnet-4-6");
    expect(row?.schedule.kind).toBe("once");
  });

  it("fails when no model is available", async () => {
    vi.spyOn(storage, "getAgentSettings").mockResolvedValue({
      agentModel: "",
    });
    const res = await createScheduledTaskTool.execute(
      { name: "t", prompt: "do", schedule: { kind: "daily", hour: 9, minute: 0 } },
      ctx,
    );
    expect(res.created).toBe(false);
  });
});

describe("list_scheduled_tasks", () => {
  it("returns task summaries with formatted schedules", async () => {
    await taskDb.create({
      name: "a",
      description: "",
      prompt: "p",
      agentModel: "openai:gpt-4o",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      enabled: true,
      needsBrowser: true,
    });
    const res = await listScheduledTasksTool.execute({}, ctx);
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0].name).toBe("a");
    expect(res.tasks[0].schedule).toBe("Daily at 09:00");
    expect(res.tasks[0].enabled).toBe(true);
  });
});

describe("update_scheduled_task", () => {
  it("pauses (enabled=false) and resumes a task", async () => {
    const t = await taskDb.create({
      name: "t",
      description: "",
      prompt: "p",
      agentModel: "openai:gpt-4o",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      enabled: true,
      needsBrowser: true,
    });
    const paused = await updateScheduledTaskTool.execute(
      { id: t.id, enabled: false },
      ctx,
    );
    expect(paused.updated).toBe(true);
    expect((await taskDb.get(t.id))?.enabled).toBe(false);

    await updateScheduledTaskTool.execute({ id: t.id, enabled: true }, ctx);
    expect((await taskDb.get(t.id))?.enabled).toBe(true);
  });

  it("updates schedule and recomputes nextRunAt", async () => {
    const t = await taskDb.create({
      name: "t",
      description: "",
      prompt: "p",
      agentModel: "openai:gpt-4o",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      enabled: true,
      needsBrowser: true,
    });
    const before = (await taskDb.get(t.id))?.nextRunAt;
    await updateScheduledTaskTool.execute(
      { id: t.id, schedule: { kind: "hourly", minute: 30 } },
      ctx,
    );
    const after = await taskDb.get(t.id);
    expect(after?.schedule.kind).toBe("hourly");
    expect(after?.nextRunAt).not.toBe(before);
  });

  it("fails for an unknown id", async () => {
    const res = await updateScheduledTaskTool.execute(
      { id: "nope", enabled: false },
      ctx,
    );
    expect(res.updated).toBe(false);
  });
});
