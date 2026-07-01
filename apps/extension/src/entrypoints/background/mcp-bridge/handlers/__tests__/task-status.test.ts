import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the `task_status` RPC handler. Each test seeds
 * `tasksStore` directly (the simpler way to drive each branch than
 * routing through `handleTask`).
 */

beforeEach(() => {
  (globalThis as any).chrome = {
    runtime: { getManifest: () => ({ version: "0.0.0" }) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  };
});

afterEach(async () => {
  const { tasksStore } = await import("../../../tasks-store");
  tasksStore._resetForTests();
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/task-status", () => {
  it("rejects when taskId is missing", async () => {
    const { handleTaskStatus } = await import("../task-status");
    await expect(
      handleTaskStatus({}, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("rejects task_not_found for unknown ids", async () => {
    const { handleTaskStatus } = await import("../task-status");
    await expect(
      handleTaskStatus(
        { taskId: "ghost" },
        { authContext: { sub: "c1" }, emitEvent: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "task_not_found" });
  });

  it("rejects task_not_found for cross-host probes (no enumeration)", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c-owner", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    const { handleTaskStatus } = await import("../task-status");
    await expect(
      handleTaskStatus(
        { taskId: "t1" },
        { authContext: { sub: "c-other" }, emitEvent: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "task_not_found" });
  });

  it("returns running for a fresh task", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    const { handleTaskStatus } = await import("../task-status");
    const r = await handleTaskStatus(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(r).toMatchObject({
      taskId: "t1",
      conversationId: "conv1",
      status: "running",
      startedAt: 100,
    });
    expect(r.output).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("returns awaiting_confirmation when the task is parked on consent", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
      status: "awaiting_confirmation",
    });
    const { handleTaskStatus } = await import("../task-status");
    const r = await handleTaskStatus(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(r.status).toBe("awaiting_confirmation");
  });

  it("returns completed with output", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    tasksStore.markCompleted("t1", "the final assistant text");
    const { handleTaskStatus } = await import("../task-status");
    const r = await handleTaskStatus(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(r.status).toBe("completed");
    expect(r.output).toBe("the final assistant text");
    expect(typeof r.endedAt).toBe("number");
  });

  it("returns errored with error code + message", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    tasksStore.markErrored("t1", { code: "agent_run_failed", message: "boom" });
    const { handleTaskStatus } = await import("../task-status");
    const r = await handleTaskStatus(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(r.status).toBe("errored");
    expect(r.error).toEqual({ code: "agent_run_failed", message: "boom" });
  });

  it("returns cancelled for a host- or user-cancelled task", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    tasksStore.markCancelled("t1");
    const { handleTaskStatus } = await import("../task-status");
    const r = await handleTaskStatus(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(r.status).toBe("cancelled");
  });

  it("includes progress when lastEvent is set", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    tasksStore.setProgress("t1", {
      lastEvent: "Finished navigate",
      currentUrl: "https://example.com",
      stepCounter: 3,
    });
    const { handleTaskStatus } = await import("../task-status");
    const r = await handleTaskStatus(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(r.progress).toEqual({
      step: 3,
      lastEvent: "Finished navigate",
      currentUrl: "https://example.com",
    });
  });

  it("omits progress when no event has fired yet", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    const { handleTaskStatus } = await import("../task-status");
    const r = await handleTaskStatus(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(r.progress).toBeUndefined();
  });
});
