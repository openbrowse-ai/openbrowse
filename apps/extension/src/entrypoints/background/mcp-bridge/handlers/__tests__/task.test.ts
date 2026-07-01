import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRunMcpTask = vi.fn();
const mockPreflightAgent = vi.fn();
vi.mock("../../mcp-task-runner", () => ({
  runMcpTask: mockRunMcpTask,
  preflightAgent: mockPreflightAgent,
}));

const mockAwait = vi.fn();
vi.mock("../../confirmation", () => ({
  awaitConfirmation: mockAwait,
}));

const mockResolveConfirmation = vi.fn();
vi.mock("@/lib/mcp-host-policy", () => ({
  resolveConfirmation: mockResolveConfirmation,
}));

const mockRunCleanupForTask = vi.fn();
vi.mock("../../cleanup-runtime", () => ({
  runCleanupForTask: mockRunCleanupForTask,
}));

/**
 * Build a fake `McpTaskControl` whose `handle.status` is whatever
 * the test needs. Under async dispatch (2026-06-29) the `task`
 * handler fires the runner in the background and returns
 * immediately; `handle.status` therefore drives what the runner
 * eventually writes into `tasksStore`, not what `handleTask`
 * returns.
 */
function fakeControl(opts: {
  conversationId?: string;
  status?: "running" | "completed" | "errored" | "aborted";
  completion?: Promise<void>;
} = {}) {
  return {
    conversationId: opts.conversationId ?? "conv1",
    completion: opts.completion ?? Promise.resolve(),
    handle: {
      conversationId: opts.conversationId ?? "conv1",
      abort: new AbortController(),
      startedAt: 0,
      status: opts.status ?? "completed",
      subscribers: new Set(),
    },
  };
}

beforeEach(async () => {
  mockRunMcpTask.mockReset();
  mockAwait.mockReset();
  mockPreflightAgent.mockReset();
  mockResolveConfirmation.mockReset();
  mockRunCleanupForTask.mockReset();
  mockPreflightAgent.mockResolvedValue({ ok: true });
  mockRunCleanupForTask.mockResolvedValue(undefined);
  // Default: auto-allow path. Tests that want the prompt path
  // override.
  mockResolveConfirmation.mockResolvedValue("auto");
  (globalThis as any).chrome = {
    windows: {
      getAll: vi.fn(async () => [{ id: 100, focused: true }]),
      get: vi.fn(async (id: number) => ({ id, focused: true })),
    },
    tabs: { query: vi.fn(async () => [{ id: 200, url: "https://example.com", active: true }]) },
    storage: { local: { get: vi.fn(async () => ({ spaces: [] })), set: vi.fn() } },
    runtime: { getManifest: () => ({ version: "0.0.0" }) },
  };
  // Drain any in-memory tasks left over from a previous test.
  const { tasksStore } = await import("../../../tasks-store");
  tasksStore._resetForTests();
});

afterEach(() => {
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("handlers/task — async dispatch", () => {
  it("auto-confirmed: returns running immediately with a taskId", async () => {
    mockRunMcpTask.mockResolvedValue(fakeControl({ conversationId: "conv1" }));
    const { handleTask } = await import("../task");
    const result = await handleTask(
      { prompt: "do the thing" },
      {
        authContext: { sub: "c1", client_name: "Cursor", scope: "task" },
        emitEvent: vi.fn(),
      },
    );
    expect(result.taskId).toBeDefined();
    expect(result.status).toBe("running");
    expect(typeof result.startedAt).toBe("number");
    // conversationId is empty in the early-return shape; the runner
    // fills it in asynchronously via tasksStore.updateConversationId.
    expect(result.conversationId).toBe("");
  });

  it("prompt path: returns awaiting_confirmation immediately", async () => {
    mockResolveConfirmation.mockResolvedValue("prompt");
    // The awaiter never resolves in this test — we only care that
    // the handler returns before the user decides.
    mockAwait.mockReturnValue(new Promise(() => {}));
    const { handleTask } = await import("../task");
    const result = await handleTask(
      { prompt: "x" },
      { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
    );
    expect(result.status).toBe("awaiting_confirmation");
    // Runner must NOT have been kicked off yet.
    expect(mockRunMcpTask).not.toHaveBeenCalled();
  });

  it("host_blocked: rejects with host_blocked (synchronously)", async () => {
    mockResolveConfirmation.mockResolvedValue("host_blocked");
    const { handleTask } = await import("../task");
    await expect(
      handleTask({ prompt: "x" }, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "host_blocked" });
  });

  it("missing prompt: rejects with invalid_params", async () => {
    const { handleTask } = await import("../task");
    await expect(
      handleTask({}, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("registers the task in tasksStore with status=running (auto path)", async () => {
    mockRunMcpTask.mockResolvedValue(fakeControl({ conversationId: "conv1" }));
    const { handleTask } = await import("../task");
    const { tasksStore } = await import("../../../tasks-store");
    expect(tasksStore.list()).toHaveLength(0);
    const result = await handleTask(
      { prompt: "x" },
      { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
    );
    const task = tasksStore.get(result.taskId);
    expect(task).toBeDefined();
    expect(task?.status).toBe("running");
    expect(task?.clientId).toBe("c1");
  });

  it("registers the task with status=awaiting_confirmation (prompt path)", async () => {
    mockResolveConfirmation.mockResolvedValue("prompt");
    mockAwait.mockReturnValue(new Promise(() => {}));
    const { handleTask } = await import("../task");
    const { tasksStore } = await import("../../../tasks-store");
    const result = await handleTask(
      { prompt: "x" },
      { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
    );
    const task = tasksStore.get(result.taskId);
    expect(task?.status).toBe("awaiting_confirmation");
  });

  it("rejects whitespace-only prompt with invalid_params", async () => {
    const { handleTask } = await import("../task");
    await expect(
      handleTask({ prompt: "   \n\t  " }, { authContext: { sub: "c1" }, emitEvent: vi.fn() }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("explicit windowId wins over space param", async () => {
    mockRunMcpTask.mockResolvedValue(fakeControl({ conversationId: "conv1" }));
    const { handleTask } = await import("../task");
    await handleTask(
      { prompt: "x", windowId: 999, space: "Personal" },
      { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
    );
    // Let the fire-and-forget runner microtask run.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockRunMcpTask).toHaveBeenCalledWith(
      expect.objectContaining({ targetWindowId: 999, spaceId: null }),
    );
  });

  it("rejects unknown space with space_not_found", async () => {
    const { handleTask } = await import("../task");
    await expect(
      handleTask(
        { prompt: "x", space: "Personal" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      ),
    ).rejects.toMatchObject({ code: "space_not_found" });
  });

  describe("preflight", () => {
    it("preflight failure rejects BEFORE policy resolution + consent", async () => {
      mockPreflightAgent.mockResolvedValue({
        ok: false,
        code: "agent_not_configured",
        message: "no model configured",
      });
      const { handleTask } = await import("../task");
      await expect(
        handleTask(
          { prompt: "x" },
          { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
        ),
      ).rejects.toMatchObject({ code: "agent_not_configured" });
      expect(mockResolveConfirmation).not.toHaveBeenCalled();
      expect(mockAwait).not.toHaveBeenCalled();
      expect(mockRunMcpTask).not.toHaveBeenCalled();
    });

    it("misconfigured provider surfaces the structured code", async () => {
      mockPreflightAgent.mockResolvedValue({
        ok: false,
        code: "agent_provider_misconfigured",
        message: "missing api key",
      });
      const { handleTask } = await import("../task");
      await expect(
        handleTask(
          { prompt: "x" },
          { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
        ),
      ).rejects.toMatchObject({ code: "agent_provider_misconfigured" });
    });
  });

  describe("background runner outcomes (mutate tasksStore async)", () => {
    it("on errored: marks the task as errored with captured error message", async () => {
      mockRunMcpTask.mockImplementation(
        async (args: { emitEvent: (e: { kind: string; message?: string }) => void }) => {
          args.emitEvent({ kind: "error", message: "transport returned null" });
          return fakeControl({ conversationId: "conv1", status: "errored" });
        },
      );
      const { handleTask } = await import("../task");
      const { tasksStore } = await import("../../../tasks-store");
      const result = await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      // Wait for the fire-and-forget runner to settle.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const task = tasksStore.get(result.taskId);
      expect(task?.status).toBe("errored");
      expect(task?.error?.message).toContain("transport returned null");
    });

    it("on aborted: marks the task as cancelled", async () => {
      mockRunMcpTask.mockResolvedValue(
        fakeControl({ conversationId: "conv1", status: "aborted" }),
      );
      const { handleTask } = await import("../task");
      const { tasksStore } = await import("../../../tasks-store");
      const result = await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const task = tasksStore.get(result.taskId);
      expect(task?.status).toBe("cancelled");
    });

    it("on completed: marks the task completed with accumulated output", async () => {
      mockRunMcpTask.mockImplementation(
        async (args: { emitEvent: (e: { kind: string; text?: string }) => void }) => {
          args.emitEvent({ kind: "text", text: "hello " });
          args.emitEvent({ kind: "text", text: "world" });
          return fakeControl({ conversationId: "conv1", status: "completed" });
        },
      );
      const { handleTask } = await import("../task");
      const { tasksStore } = await import("../../../tasks-store");
      const result = await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const task = tasksStore.get(result.taskId);
      expect(task?.status).toBe("completed");
      expect(task?.output).toBe("hello world");
    });
  });

  describe("terminal-state cleanup routing", () => {
    it("routes through runCleanupForTask('completed') on successful run", async () => {
      mockRunMcpTask.mockResolvedValue(
        fakeControl({ conversationId: "conv1", status: "completed" }),
      );
      const { handleTask } = await import("../task");
      const result = await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(mockRunCleanupForTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: result.taskId,
          conversationId: "conv1",
        }),
        "completed",
      );
    });

    it("routes through runCleanupForTask('errored') on agent run error", async () => {
      mockRunMcpTask.mockResolvedValue(
        fakeControl({ conversationId: "conv1", status: "errored" }),
      );
      const { handleTask } = await import("../task");
      const result = await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(mockRunCleanupForTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: result.taskId,
          conversationId: "conv1",
        }),
        "errored",
      );
    });

    it("routes through runCleanupForTask('cancelled') on aborted run", async () => {
      mockRunMcpTask.mockResolvedValue(
        fakeControl({ conversationId: "conv1", status: "aborted" }),
      );
      const { handleTask } = await import("../task");
      const result = await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(mockRunCleanupForTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: result.taskId,
          conversationId: "conv1",
        }),
        "cancelled",
      );
    });

    it("routes through runCleanupForTask('errored') when runMcpTask itself throws", async () => {
      mockRunMcpTask.mockRejectedValue(new Error("transport down"));
      const { handleTask } = await import("../task");
      const result = await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(mockRunCleanupForTask).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: result.taskId }),
        "errored",
      );
    });

    it("captures createdWindowId in the cleanup info when resolveTargetWindow had to create a window", async () => {
      // No windows exist initially → resolveTargetWindow falls back
      // to chrome.windows.create.
      (globalThis as any).chrome.windows.getAll = vi.fn(async () => []);
      (globalThis as any).chrome.windows.create = vi.fn(async () => ({ id: 999 }));
      mockRunMcpTask.mockResolvedValue(
        fakeControl({ conversationId: "conv1", status: "completed" }),
      );
      const { handleTask } = await import("../task");
      await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(mockRunCleanupForTask).toHaveBeenCalledWith(
        expect.objectContaining({ createdWindowId: 999 }),
        "completed",
      );
    });

    it("does NOT set createdWindowId when an existing window was used", async () => {
      // Default beforeEach: chrome.windows.getAll returns a focused window.
      mockRunMcpTask.mockResolvedValue(
        fakeControl({ conversationId: "conv1", status: "completed" }),
      );
      const { handleTask } = await import("../task");
      await handleTask(
        { prompt: "x" },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const callArg = mockRunCleanupForTask.mock.calls[0]?.[0] as
        | { createdWindowId?: number }
        | undefined;
      expect(callArg?.createdWindowId).toBeUndefined();
    });
  });

  describe("integration: cancel-task → runner aborted branch → cleanup (B6)", () => {
    it("a host-initiated cancel routes through to runCleanupForTask('cancelled')", async () => {
      // Compose handleTask + handleCancelTask in one test: launch a
      // task that produces a control whose completion stays pending
      // until the test aborts it. Then call handleCancelTask; the
      // tasksStore.cancel flips the controller's signal, the test
      // unwedges completion with status=aborted, and the runner's
      // aborted branch fires runCleanupForTask('cancelled').
      let abortedResolver: (() => void) | undefined;
      const pendingCompletion = new Promise<void>((resolve) => {
        abortedResolver = resolve;
      });
      mockRunMcpTask.mockResolvedValue(
        fakeControl({
          conversationId: "conv-cancel",
          completion: pendingCompletion,
          status: "aborted",
        }),
      );

      const { handleTask } = await import("../task");
      const { handleCancelTask } = await import("../cancel-task");

      const result = await handleTask(
        { prompt: "long-running task" },
        {
          authContext: { sub: "c1", client_name: "Cursor", scope: "task" },
          emitEvent: vi.fn(),
        },
      );
      // Let the runner attach + register before cancellation.
      await new Promise((r) => setTimeout(r, 0));

      // Host RPC cancels the task.
      await handleCancelTask(
        { taskId: result.taskId },
        { authContext: { sub: "c1", client_name: "Cursor" }, emitEvent: vi.fn() },
      );

      // Runner's completion promise resolves now that the controller
      // is aborted (real runner would resolve when its loop yields
      // to the abort signal; here we simulate by manually resolving).
      abortedResolver!();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // The aborted branch in task.ts called runCleanupForTask with
      // outcome='cancelled'. Cancel-task itself did NOT call cleanup
      // — that's the whole point of the unified cleanup architecture.
      // Asserting the exact call count guards against a future
      // regression that reintroduces inline cleanup in cancel-task.
      expect(mockRunCleanupForTask).toHaveBeenCalledTimes(1);
      expect(mockRunCleanupForTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: result.taskId,
          conversationId: "conv-cancel",
        }),
        "cancelled",
      );
    });
  });
});
