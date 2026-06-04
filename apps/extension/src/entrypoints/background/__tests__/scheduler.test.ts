// src/entrypoints/background/__tests__/scheduler.test.ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatDb } from "@/lib/chat-db";
import { taskDb } from "@/lib/schedule/task-db";
import {
  registerScheduler,
  rescheduleAll,
  runDueTasks,
  SCHEDULER_ALARM,
} from "../scheduler";

beforeEach(() => {
  indexedDB = new IDBFactory();
  chatDb._resetForTests();
});

describe("runDueTasks", () => {
  it("runs only enabled tasks whose nextRunAt <= now and not already running", async () => {
    const due = await taskDb.create({
      name: "due",
      description: "",
      prompt: "p",
      agentModel: "openai:gpt-4o",
      schedule: { kind: "daily", hour: 0, minute: 0 },
      enabled: true,
      needsBrowser: false,
    });
    const future = await taskDb.create({
      name: "future",
      description: "",
      prompt: "p",
      agentModel: "openai:gpt-4o",
      schedule: { kind: "daily", hour: 0, minute: 0 },
      enabled: true,
      needsBrowser: false,
    });
    const disabled = await taskDb.create({
      name: "off",
      description: "",
      prompt: "p",
      agentModel: "openai:gpt-4o",
      schedule: { kind: "daily", hour: 0, minute: 0 },
      enabled: false,
      needsBrowser: false,
    });

    // Force nextRunAt: due in the past, future in the future.
    await taskDb.update(due.id, { nextRunAt: 100 });
    await taskDb.update(future.id, { nextRunAt: 10_000 });
    await taskDb.update(disabled.id, { nextRunAt: 100 });

    const ran: string[] = [];
    await runDueTasks(1_000, async (id) => {
      ran.push(id);
    });

    expect(ran).toEqual([due.id]);
  });

  it("does not dispatch a task already marked running", async () => {
    const t = await taskDb.create({
      name: "r",
      description: "",
      prompt: "p",
      agentModel: "openai:gpt-4o",
      schedule: { kind: "daily", hour: 0, minute: 0 },
      enabled: true,
      needsBrowser: false,
    });
    await taskDb.update(t.id, { nextRunAt: 100, lastRunStatus: "running" });

    const ran: string[] = [];
    await runDueTasks(1_000, async (id) => ran.push(id) as unknown as void);
    expect(ran).toEqual([]);
  });
});

describe("rescheduleAll (skip missed runs on startup)", () => {
  it("recomputes nextRunAt forward, never firing a missed run immediately", async () => {
    const t = await taskDb.create({
      name: "t",
      description: "",
      prompt: "p",
      agentModel: "openai:gpt-4o",
      schedule: { kind: "daily", hour: 9, minute: 0 },
      enabled: true,
      needsBrowser: false,
    });
    // Simulate a stale nextRunAt from when Chrome was last open.
    await taskDb.update(t.id, { nextRunAt: 1 });

    await rescheduleAll(Date.now());

    const after = await taskDb.get(t.id);
    expect(after!.nextRunAt!).toBeGreaterThan(Date.now()); // forward, not 1
  });
});

describe("registerScheduler", () => {
  it("creates the tick alarm and an onAlarm listener", () => {
    const create = vi.fn();
    const addListener = vi.fn();
    vi.stubGlobal("chrome", {
      alarms: { create, onAlarm: { addListener }, clear: vi.fn() },
    });
    registerScheduler();
    expect(create).toHaveBeenCalledWith(
      SCHEDULER_ALARM,
      expect.objectContaining({ periodInMinutes: 1 }),
    );
    expect(addListener).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
