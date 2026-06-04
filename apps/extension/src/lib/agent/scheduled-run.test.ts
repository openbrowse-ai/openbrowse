// src/lib/agent/scheduled-run.test.ts
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { chatDb } from "@/lib/chat-db";
import { taskDb } from "@/lib/schedule/task-db";
import { runScheduledTask } from "./scheduled-run";

beforeEach(() => {
  indexedDB = new IDBFactory();
  chatDb._resetForTests();
});

async function seedTask(over: Record<string, unknown> = {}) {
  return taskDb.create({
    name: "t",
    description: "d",
    prompt: "do the thing",
    agentModel: "openai:gpt-4o",
    schedule: { kind: "daily", hour: 9, minute: 0 },
    enabled: true,
    needsBrowser: true,
    ...over,
  });
}

describe("runScheduledTask", () => {
  it("hosts the run, awaits its result, finalizes the child + bookkeeping + notifies", async () => {
    const task = await seedTask();
    const hosted: string[] = [];
    const notified: any[] = [];

    const result = await runScheduledTask(task.id, {
      hostRun: async ({ childConversationId }) => {
        hosted.push(childConversationId);
      },
      awaitResult: async () => ({ finalText: "All set.", status: "success" }),
      notify: (p) => notified.push(p),
      now: () => 1_000_000,
    });

    expect(result.status).toBe("success");
    expect(hosted).toHaveLength(1);
    expect(notified).toHaveLength(1);
    expect(notified[0].kind).toBe("complete");

    const after = await taskDb.get(task.id);
    expect(after?.lastRunStatus).toBe("success");
    expect(after?.lastRunAt).toBe(1_000_000);
    expect(after?.lastRunConversationId).toBeTruthy();
    expect(after?.nextRunAt).toBeTypeOf("number");
    expect(after?.taskConversationId).toBeTruthy();

    const children = await chatDb.listChildren(after!.taskConversationId!);
    expect(children).toHaveLength(1);
    expect(children[0].subagentStatus).toBe("completed");
  });

  it("records error status when the host/await throws", async () => {
    const task = await seedTask();
    const result = await runScheduledTask(task.id, {
      hostRun: async () => {},
      awaitResult: async () => {
        throw new Error("boom");
      },
      notify: () => {},
      now: () => 2_000_000,
    });
    expect(result.status).toBe("error");
    const after = await taskDb.get(task.id);
    expect(after?.lastRunStatus).toBe("error");
    expect(after?.lastRunError).toContain("boom");
  });

  it("records error status when the run reports failure", async () => {
    const task = await seedTask();
    await runScheduledTask(task.id, {
      hostRun: async () => {},
      awaitResult: async () => ({
        finalText: "",
        status: "error",
        errorMessage: "stalled",
      }),
      notify: () => {},
      now: () => 4_000_000,
    });
    const after = await taskDb.get(task.id);
    expect(after?.lastRunStatus).toBe("error");
    expect(after?.lastRunError).toBe("stalled");
  });

  it("skips a task already marked running (no double-fire)", async () => {
    const task = await seedTask();
    await taskDb.update(task.id, { lastRunStatus: "running" });
    let hostCalls = 0;

    const result = await runScheduledTask(task.id, {
      hostRun: async () => {
        hostCalls += 1;
      },
      awaitResult: async () => ({ finalText: "x", status: "success" }),
      notify: () => {},
      now: () => 5_000_000,
    });

    expect(result.status).toBe("skipped");
    expect(hostCalls).toBe(0);
  });

  it("recomputes nextRunAt (manual stays null)", async () => {
    const task = await seedTask({ schedule: { kind: "manual" } });
    await runScheduledTask(task.id, {
      hostRun: async () => {},
      awaitResult: async () => ({ finalText: "ok", status: "success" }),
      notify: () => {},
      now: () => 3_000_000,
    });
    const after = await taskDb.get(task.id);
    expect(after?.nextRunAt).toBeNull();
  });
});
