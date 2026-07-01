import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the `task_wait` long-poll RPC. Drives `tasksStore`
 * directly to set up each branch (already-terminal,
 * transitions-to-terminal, timeout, error paths). The handler is
 * pure event-driven — no chrome.* APIs touched — so the global
 * stub is minimal.
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

describe("handlers/task-wait — guard rails", () => {
  it("rejects when taskId is missing", async () => {
    const { handleTaskWait } = await import("../task-wait");
    await expect(
      handleTaskWait({}, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("rejects task_not_found for unknown ids", async () => {
    const { handleTaskWait } = await import("../task-wait");
    await expect(
      handleTaskWait(
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
    const { handleTaskWait } = await import("../task-wait");
    await expect(
      handleTaskWait(
        { taskId: "t1" },
        { authContext: { sub: "c-other" }, emitEvent: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "task_not_found" });
  });
});

describe("handlers/task-wait — fast path", () => {
  it("returns immediately when the task is already completed", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    tasksStore.markCompleted("t1", "the final answer");
    const { handleTaskWait } = await import("../task-wait");
    const result = await handleTaskWait(
      { taskId: "t1", timeoutMs: 60_000 },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(result.status).toBe("completed");
    expect(result.output).toBe("the final answer");
  });

  it("returns immediately when the task is already errored", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    tasksStore.markErrored("t1", { code: "agent_run_failed", message: "boom" });
    const { handleTaskWait } = await import("../task-wait");
    const result = await handleTaskWait(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(result.status).toBe("errored");
    expect(result.error).toEqual({ code: "agent_run_failed", message: "boom" });
  });

  it("returns immediately when the task is already cancelled", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    tasksStore.markCancelled("t1");
    const { handleTaskWait } = await import("../task-wait");
    const result = await handleTaskWait(
      { taskId: "t1" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(result.status).toBe("cancelled");
  });
});

describe("handlers/task-wait — long-poll", () => {
  it("resolves when the task transitions to completed mid-wait", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    const { handleTaskWait } = await import("../task-wait");
    const promise = handleTaskWait(
      { taskId: "t1", timeoutMs: 5_000 },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    // Settle a microtask so the subscription is wired before we
    // emit the transition.
    await new Promise((r) => setTimeout(r, 0));
    tasksStore.markCompleted("t1", "yay");
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.output).toBe("yay");
  });

  it("resolves when the task transitions to errored mid-wait", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    const { handleTaskWait } = await import("../task-wait");
    const promise = handleTaskWait(
      { taskId: "t1", timeoutMs: 5_000 },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    await new Promise((r) => setTimeout(r, 0));
    tasksStore.markErrored("t1", { code: "oops", message: "no" });
    const result = await promise;
    expect(result.status).toBe("errored");
  });

  it("ignores non-terminal transitions and keeps waiting", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
      status: "awaiting_confirmation",
    });
    const { handleTaskWait } = await import("../task-wait");
    let settled = false;
    const promise = handleTaskWait(
      { taskId: "t1", timeoutMs: 5_000 },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    ).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 0));

    // awaiting_confirmation → running: a transition, but NOT
    // terminal. The wait must keep blocking.
    tasksStore.setRunning("t1");
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    // Now mark completed; the wait should resolve.
    tasksStore.markCompleted("t1", "done");
    const result = await promise;
    expect(result.status).toBe("completed");
  });
});

describe("handlers/task-wait — timeout", () => {
  it("resolves with the current non-terminal status when timeoutMs elapses", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    const { handleTaskWait } = await import("../task-wait");
    vi.useFakeTimers();
    try {
      const promise = handleTaskWait(
        { taskId: "t1", timeoutMs: 5_000 },
        { authContext: { sub: "c1" }, emitEvent: vi.fn() },
      );
      // Settle one microtask so the subscription + timer are
      // installed before we advance the clock.
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await promise;
      // The task never transitioned, so the timeout returns the
      // running snapshot.
      expect(result.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps timeoutMs above MAX_WAIT_MS", async () => {
    const { MAX_WAIT_MS } = await import("../task-wait");
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    const { handleTaskWait } = await import("../task-wait");
    vi.useFakeTimers();
    try {
      const promise = handleTaskWait(
        // Two hours, way over the 15-min cap.
        { taskId: "t1", timeoutMs: 7_200_000 },
        { authContext: { sub: "c1" }, emitEvent: vi.fn() },
      );
      await Promise.resolve();
      // Advancing past MAX_WAIT_MS should fire the timer.
      await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + 100);
      const result = await promise;
      expect(result.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats negative timeoutMs as 0 (returns the current snapshot ~immediately)", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "h", prompt: "p",
      conversationId: "conv1", targetWindowId: 0,
      controller: new AbortController(), startedAt: 100,
    });
    const { handleTaskWait } = await import("../task-wait");
    const result = await handleTaskWait(
      { taskId: "t1", timeoutMs: -1 },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(result.status).toBe("running");
  });

  it("uses the default timeout when host omits timeoutMs", async () => {
    const { DEFAULT_TIMEOUT_MS } = await import("../task-wait");
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
  });
});
