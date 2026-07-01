import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(async () => {
  // Fresh IDB per test — both chatDb and tab-registry persist nothing
  // directly, but chatDb does, so we reset its cached connection.
  indexedDB = new IDBFactory();
  const { chatDb } = await import("@/lib/chat-db");
  chatDb._resetForTests();

  // chrome.storage.local with a real in-memory backing so
  // mcp-host-policy + settings can round-trip through the
  // get/set/remove APIs (the policy-aware tests below set a policy
  // and then expect resolveConfirmation to read it back).
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    tabs: { remove: vi.fn(async (_id: number) => {}) },
    runtime: { getManifest: () => ({ version: "0.0.0" }) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(store, obj);
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
});
afterEach(async () => {
  const { tasksStore } = await import("../../../tasks-store");
  tasksStore._resetForTests();
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/cancel-task", () => {
  it("aborts a running task owned by the same client", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    const controller = new AbortController();
    tasksStore.register({
      taskId: "t1", clientId: "c1", hostName: "Cursor", prompt: "x",
      conversationId: "conv1", targetWindowId: 1, spaceId: null,
      controller, startedAt: 0,
    });

    const { handleCancelTask } = await import("../cancel-task");
    const emitEvent = vi.fn();
    const result = await handleCancelTask(
      { taskId: "t1" },
      { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent },
    );
    expect(result.cancelled).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // 2026-06-29 async dispatch: cancel transitions the row to
    // `cancelled` and keeps it in the store so `task_status` can
    // return the terminal state. The row is evicted later by the
    // TTL sweeper.
    expect(tasksStore.get("t1")?.status).toBe("cancelled");
    expect(emitEvent).toHaveBeenCalledWith({ kind: "user-confirmed", outcome: "deny" });
  });

  it("dismisses the user prompt as deny for awaiting_confirmation tasks", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    const { confirmPrompt } = await import("../../confirmation");
    // Drive a real pending prompt via the confirmation module so
    // confirmPrompt actually has something to resolve. The simplest
    // path: register an always-prompt policy and call
    // awaitConfirmation; the awaiter promise stays pending and the
    // pending map gets a fresh promptId we can read via
    // listPendingPrompts.
    const { setPolicy } = await import("@/lib/mcp-host-policy");
    await setPolicy("c1", "always-prompt");
    const { awaitConfirmation, listPendingPrompts } = await import("../../confirmation");
    const awaiter = awaitConfirmation({
      clientId: "c1", hostName: "h", prompt: "x",
      targetWindowInfo: { windowId: 1 }, hostRequest: "auto",
    });
    await new Promise((r) => setTimeout(r, 0));
    const pendingId = listPendingPrompts()[0].promptId;

    tasksStore.register({
      taskId: "t-await", clientId: "c1", hostName: "Cursor", prompt: "x",
      conversationId: "", targetWindowId: 1,
      controller: new AbortController(), startedAt: 0,
      status: "awaiting_confirmation",
      pendingPromptId: pendingId,
    });

    const { handleCancelTask } = await import("../cancel-task");
    const result = await handleCancelTask(
      { taskId: "t-await" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );
    expect(result.cancelled).toBe(true);
    // The awaiter should resolve to "deny" (dismissed).
    await expect(awaiter).resolves.toBe("deny");
    // Sanity: confirmPrompt is the same mechanism; verifying it
    // would dismiss a different prompt id (returns false because
    // the original was already resolved).
    expect(confirmPrompt(pendingId, "deny")).toBe(false);
  });

  it("rejects when taskId is not owned by the caller", async () => {
    const { tasksStore } = await import("../../../tasks-store");
    tasksStore.register({
      taskId: "t2", clientId: "c1", hostName: "Cursor", prompt: "x",
      conversationId: "conv1", targetWindowId: 1, spaceId: null,
      controller: new AbortController(), startedAt: 0,
    });

    const { handleCancelTask } = await import("../cancel-task");
    await expect(
      handleCancelTask(
        { taskId: "t2" },
        { authContext: { sub: "different_client" }, emitEvent: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "task_not_found" });
  });

  it("rejects when taskId is missing", async () => {
    const { handleCancelTask } = await import("../cancel-task");
    await expect(
      handleCancelTask({}, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("returns task_not_found for unknown id (avoids enumeration)", async () => {
    const { handleCancelTask } = await import("../cancel-task");
    await expect(
      handleCancelTask(
        { taskId: "nonexistent" },
        { authContext: { sub: "c1" }, emitEvent: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "task_not_found" });
  });

  it("does NOT close tabs inline — cleanup is the runner's responsibility (task.ts aborted branch)", async () => {
    // Post-2026-06-30 unified cleanup: cancel-task ONLY signals the
    // abort. The runner's aborted-branch in task.ts then routes
    // through `runCleanupForTask("cancelled")`. We verify that
    // cancel-task itself never touches chrome.tabs.remove.
    const { tasksStore } = await import("../../../tasks-store");
    const { tabRegistry } = await import("@/lib/agent/tab-registry");
    const { chatDb } = await import("@/lib/chat-db");

    const ltid1 = tabRegistry.registerExisting(101);
    const ltid2 = tabRegistry.registerExisting(102);
    await chatDb.createConversation({
      id: "conv-close", title: "t", spaceId: null,
      createdAt: 0, updatedAt: 0,
      ownedLtids: [ltid1, ltid2],
    });

    tasksStore.register({
      taskId: "t3", clientId: "c1", hostName: "Cursor", prompt: "x",
      conversationId: "conv-close", targetWindowId: 1, spaceId: null,
      controller: new AbortController(), startedAt: 0,
    });

    const { handleCancelTask } = await import("../cancel-task");
    await handleCancelTask(
      { taskId: "t3" },
      { authContext: { sub: "c1" }, emitEvent: vi.fn() },
    );

    const remove = (globalThis as any).chrome.tabs.remove as ReturnType<typeof vi.fn>;
    expect(remove).not.toHaveBeenCalled();

    tabRegistry.__resetForTests!();
  });
});
