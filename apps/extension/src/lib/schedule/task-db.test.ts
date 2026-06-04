// src/lib/schedule/task-db.test.ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskDb } from "./task-db";

beforeEach(() => {
  indexedDB = new IDBFactory();
  // chat-db caches its connection promise; reset it so each test gets a
  // fresh DB. _resetForTests clears the cached promise.
  return import("@/lib/chat-db").then((m) => m.chatDb._resetForTests());
});

function makeTask(over: Partial<Parameters<typeof taskDb.create>[0]> = {}) {
  return {
    name: "daily-brief",
    description: "Morning digest",
    prompt: "Summarize AI news",
    agentModel: "openai:gpt-4o",
    schedule: { kind: "daily" as const, hour: 9, minute: 0 },
    enabled: true,
    needsBrowser: true,
    ...over,
  };
}

describe("taskDb", () => {
  it("creates a task with id/timestamps and computed nextRunAt", async () => {
    const task = await taskDb.create(makeTask());
    expect(task.id).toBeTruthy();
    expect(task.createdAt).toBeGreaterThan(0);
    expect(task.updatedAt).toBe(task.createdAt);
    expect(task.nextRunAt).toBeTypeOf("number");

    const fetched = await taskDb.get(task.id);
    expect(fetched?.name).toBe("daily-brief");
  });

  it("lists tasks", async () => {
    await taskDb.create(makeTask({ name: "a" }));
    await taskDb.create(makeTask({ name: "b" }));
    const all = await taskDb.list();
    expect(all.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("updates a task and recomputes nextRunAt when schedule changes", async () => {
    const task = await taskDb.create(makeTask());
    const before = task.nextRunAt;
    await taskDb.update(task.id, {
      schedule: { kind: "hourly", minute: 30 },
    });
    const after = await taskDb.get(task.id);
    expect(after?.schedule.kind).toBe("hourly");
    expect(after?.nextRunAt).not.toBe(before);
    expect(after!.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);
  });

  it("manual schedule yields null nextRunAt", async () => {
    const task = await taskDb.create(makeTask({ schedule: { kind: "manual" } }));
    expect(task.nextRunAt).toBeNull();
  });

  it("removes a task", async () => {
    const task = await taskDb.create(makeTask());
    await taskDb.remove(task.id);
    expect(await taskDb.get(task.id)).toBeUndefined();
  });

  it("notifies subscribers on create/update/remove", async () => {
    const fn = vi.fn();
    const unsub = taskDb.subscribe(fn);
    const task = await taskDb.create(makeTask());
    await taskDb.update(task.id, { enabled: false });
    await taskDb.remove(task.id);
    expect(fn).toHaveBeenCalledTimes(3);
    unsub();
    await taskDb.create(makeTask());
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
