import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * tests for `tasksStore` covering the 2026-06-29 async-dispatch
 * lifecycle: explicit status field, terminal-state retention,
 * TTL eviction, and the new transition helpers.
 *
 * Each test imports the module fresh and resets the singleton store
 * via the test-only escape hatch so cases don't bleed state.
 */

beforeEach(() => {
  vi.resetModules();
});
afterEach(async () => {
  // Stop any pending sweeper interval the test left behind so the
  // node test process can exit cleanly.
  const { tasksStore } = await import("../tasks-store");
  tasksStore._resetForTests();
  vi.resetModules();
});

describe("tasks-store — basic registration", () => {
  it("registers a task and lists it", async () => {
    const { tasksStore } = await import("../tasks-store");
    const controller = new AbortController();
    tasksStore.register({
      taskId: "t1",
      clientId: "c1",
      hostName: "Test Host",
      prompt: "do the thing",
      conversationId: "conv1",
      targetWindowId: 1,
      controller,
      startedAt: 0,
    });
    expect(tasksStore.list().map((t) => t.taskId)).toEqual(["t1"]);
    expect(tasksStore.get("t1")?.hostName).toBe("Test Host");
    expect(tasksStore.get("t1")?.status).toBe("running");
  });

  it("respects an explicit status on register", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t1",
      clientId: "c1",
      hostName: "h",
      prompt: "p",
      conversationId: "c",
      targetWindowId: 0,
      controller: new AbortController(),
      startedAt: 0,
      status: "awaiting_confirmation",
    });
    expect(tasksStore.get("t1")?.status).toBe("awaiting_confirmation");
  });

  it("clear hard-removes a task immediately", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t2", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    tasksStore.clear("t2");
    expect(tasksStore.get("t2")).toBeUndefined();
  });

  it("updateConversationId patches an existing task", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t-uc1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "old", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    tasksStore.updateConversationId("t-uc1", "new-conv-id");
    expect(tasksStore.get("t-uc1")?.conversationId).toBe("new-conv-id");
  });

  it("updateConversationId is a no-op for unknown taskIds", async () => {
    const { tasksStore } = await import("../tasks-store");
    expect(() => tasksStore.updateConversationId("nonexistent", "x")).not.toThrow();
    expect(tasksStore.get("nonexistent")).toBeUndefined();
  });

  it("isolates tasks across clientId for ownership checks", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t4", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    expect(tasksStore.getOwnedBy("t4", "c1")).toBeDefined();
    expect(tasksStore.getOwnedBy("t4", "different")).toBeUndefined();
  });
});

describe("tasks-store — status transitions", () => {
  it("setRunning promotes awaiting_confirmation to running", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
      status: "awaiting_confirmation",
      pendingPromptId: "p1",
    });
    tasksStore.setRunning("t1");
    const task = tasksStore.get("t1");
    expect(task?.status).toBe("running");
    expect(task?.pendingPromptId).toBeUndefined();
  });

  it("setRunning is a no-op if the task is already running", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    tasksStore.setRunning("t1");
    expect(tasksStore.get("t1")?.status).toBe("running");
  });

  it("setProgress writes truncated lastEvent + currentUrl", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    const longEvent = "x".repeat(500);
    const longUrl = "https://example.com/" + "p".repeat(800);
    tasksStore.setProgress("t1", {
      lastEvent: longEvent,
      currentUrl: longUrl,
      stepCounter: 3,
    });
    const task = tasksStore.get("t1");
    expect(task?.lastEvent?.length).toBeLessThanOrEqual(200);
    expect(task?.lastEvent).toContain("…");
    expect(task?.currentUrl?.length).toBeLessThanOrEqual(500);
    expect(task?.currentUrl).toContain("…");
    expect(task?.stepCounter).toBe(3);
  });

  it("markCompleted sets status, output, endedAt", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    tasksStore.markCompleted("t1", "final text");
    const task = tasksStore.get("t1");
    expect(task?.status).toBe("completed");
    expect(task?.output).toBe("final text");
    expect(typeof task?.endedAt).toBe("number");
  });

  it("markErrored sets status, error, endedAt", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    tasksStore.markErrored("t1", { code: "agent_run_failed", message: "boom" });
    const task = tasksStore.get("t1");
    expect(task?.status).toBe("errored");
    expect(task?.error).toEqual({ code: "agent_run_failed", message: "boom" });
    expect(typeof task?.endedAt).toBe("number");
  });

  it("markCancelled sets status + endedAt without aborting the controller", async () => {
    const { tasksStore } = await import("../tasks-store");
    const controller = new AbortController();
    tasksStore.register({
      taskId: "t1", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller, startedAt: 0,
    });
    tasksStore.markCancelled("t1");
    expect(tasksStore.get("t1")?.status).toBe("cancelled");
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("tasks-store — cancel (imperative)", () => {
  it("aborts the controller, transitions to cancelled, KEEPS the row", async () => {
    const { tasksStore } = await import("../tasks-store");
    const controller = new AbortController();
    const aborted = new Promise<void>((r) =>
      controller.signal.addEventListener("abort", () => r()),
    );
    tasksStore.register({
      taskId: "t3", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0, controller, startedAt: 0,
    });
    const ok = tasksStore.cancel("t3");
    expect(ok).toBe(true);
    await aborted;
    // 2026-06-29: cancel no longer hard-removes the task. The row
    // lingers in `cancelled` state so `task_status` can return the
    // terminal state until the TTL sweeper evicts it.
    const task = tasksStore.get("t3");
    expect(task).toBeDefined();
    expect(task?.status).toBe("cancelled");
  });

  it("returns false when taskId is unknown", async () => {
    const { tasksStore } = await import("../tasks-store");
    expect(tasksStore.cancel("nonexistent")).toBe(false);
  });
});

describe("tasks-store — TTL sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps terminal tasks after TERMINAL_TTL_MS", async () => {
    const { tasksStore, TERMINAL_TTL_MS } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t-old", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    tasksStore.markCompleted("t-old", "done");
    expect(tasksStore.get("t-old")?.status).toBe("completed");
    // Advance past TTL + one sweep interval (60s) so the sweeper
    // sees the entry as expired.
    vi.advanceTimersByTime(TERMINAL_TTL_MS + 61_000);
    expect(tasksStore.get("t-old")).toBeUndefined();
  });

  it("keeps live (running) tasks indefinitely", async () => {
    const { tasksStore, TERMINAL_TTL_MS } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t-live", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    // Trigger sweeper start by transitioning another task to terminal.
    tasksStore.register({
      taskId: "t-other", clientId: "c", hostName: "h", prompt: "p",
      conversationId: "c", targetWindowId: 0,
      controller: new AbortController(), startedAt: 0,
    });
    tasksStore.markCompleted("t-other", "ok");
    vi.advanceTimersByTime(TERMINAL_TTL_MS + 61_000);
    expect(tasksStore.get("t-live")?.status).toBe("running");
  });
});
