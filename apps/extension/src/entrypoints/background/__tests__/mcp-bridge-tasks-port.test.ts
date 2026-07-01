import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the `mcp-bridge:tasks` push channel. Same shape as
 * `mcp-bridge-prompts-port.test.ts`.
 */

interface FakePort {
  name: string;
  posted: unknown[];
  onMessage: { addListener: (cb: (m: unknown) => void) => void; listeners: ((m: unknown) => void)[] };
  onDisconnect: { addListener: (cb: () => void) => void; listeners: (() => void)[] };
  postMessage: (m: unknown) => void;
  disconnect: () => void;
}

function makeFakePort(name: string, throwOnPost = false): FakePort {
  const port: FakePort = {
    name,
    posted: [],
    onMessage: { addListener: (cb) => { port.onMessage.listeners.push(cb); }, listeners: [] },
    onDisconnect: { addListener: (cb) => { port.onDisconnect.listeners.push(cb); }, listeners: [] },
    postMessage: (m) => {
      if (throwOnPost) throw new Error("port closed");
      port.posted.push(m);
    },
    disconnect: () => {
      for (const cb of port.onDisconnect.listeners) cb();
    },
  };
  return port;
}

describe("mcp-bridge-tasks-port — toPublicSummary", () => {
  it("strips clientId + controller and surfaces only public fields", async () => {
    const { toPublicSummary } = await import("../mcp-bridge-tasks-port");
    const controller = new AbortController();
    expect(
      toPublicSummary({
        taskId: "t1",
        clientId: "secret-id-do-not-leak",
        hostName: "Cursor",
        prompt: "summarise",
        conversationId: "conv1",
        targetWindowId: 100,
        spaceId: "sp",
        controller,
        startedAt: 1000,
        taskTitlePreview: "Summarise unread",
        status: "running",
        currentUrl: "https://example.com/page",
      }),
    ).toEqual({
      taskId: "t1",
      hostName: "Cursor",
      prompt: "summarise",
      conversationId: "conv1",
      targetWindowId: 100,
      spaceId: "sp",
      startedAt: 1000,
      taskTitlePreview: "Summarise unread",
      status: "running",
      endedAt: null,
      lastEvent: null,
      currentUrl: "https://example.com/page",
    });
  });

  it("nulls missing spaceId / taskTitlePreview / currentUrl so the wire never carries undefined", async () => {
    const { toPublicSummary } = await import("../mcp-bridge-tasks-port");
    const controller = new AbortController();
    const out = toPublicSummary({
      taskId: "t2",
      clientId: "c",
      hostName: "h",
      prompt: "p",
      conversationId: "x",
      targetWindowId: 0,
      controller,
      startedAt: 0,
      status: "running",
    });
    expect(out.spaceId).toBeNull();
    expect(out.taskTitlePreview).toBeNull();
    expect(out.currentUrl).toBeNull();
  });

  it("surfaces conversationId so the UI can deep-link to the conversation", async () => {
    const { toPublicSummary } = await import("../mcp-bridge-tasks-port");
    const controller = new AbortController();
    const out = toPublicSummary({
      taskId: "t3",
      clientId: "c",
      hostName: "h",
      prompt: "p",
      conversationId: "conv-xyz",
      targetWindowId: 0,
      controller,
      startedAt: 0,
      status: "running",
    });
    // conversationId is null in the brief window between
    // tasksStore.register and updateConversationId. The UI uses
    // null as the "not yet available" signal — see ActiveTaskCard.
    expect(out.conversationId).toBe("conv-xyz");
  });

  it("normalises an empty conversationId to null (the 'not yet available' marker)", async () => {
    const { toPublicSummary } = await import("../mcp-bridge-tasks-port");
    const controller = new AbortController();
    const out = toPublicSummary({
      taskId: "t4",
      clientId: "c",
      hostName: "h",
      prompt: "p",
      conversationId: "",
      targetWindowId: 0,
      controller,
      startedAt: 0,
      status: "running",
    });
    // Wire-side type is `string | null` (was previously `string`
    // with empty-string sentinel). The new shape forces UI consumers
    // to handle the not-yet-available state explicitly instead of
    // relying on the sentinel convention.
    expect(out.conversationId).toBeNull();
  });
});

describe("mcp-bridge-tasks-port — port channel", () => {
  let onConnectListener: ((p: FakePort) => void) | null = null;

  beforeEach(() => {
    onConnectListener = null;
    (globalThis as any).chrome = {
      runtime: {
        onConnect: {
          addListener: (cb: (p: FakePort) => void) => {
            onConnectListener = cb;
          },
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
    vi.resetModules();
  });

  it("ignores ports with a different name", async () => {
    const { attachTasksPort } = await import("../mcp-bridge-tasks-port");
    attachTasksPort();
    expect(onConnectListener).not.toBeNull();
    const port = makeFakePort("some-other-port");
    onConnectListener!(port);
    expect(port.posted).toEqual([]);
  });

  it("sends an empty snapshot immediately on connect", async () => {
    const { attachTasksPort, TASKS_PORT_NAME } = await import(
      "../mcp-bridge-tasks-port"
    );
    attachTasksPort();
    const port = makeFakePort(TASKS_PORT_NAME);
    onConnectListener!(port);
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]).toEqual({
      type: "MCP_BRIDGE_TASKS_TICK",
      tasks: [],
    });
  });

  it("pushes a fresh snapshot when a task is registered then cleared", async () => {
    const { attachTasksPort, TASKS_PORT_NAME } = await import(
      "../mcp-bridge-tasks-port"
    );
    attachTasksPort();
    const port = makeFakePort(TASKS_PORT_NAME);
    onConnectListener!(port);
    const { tasksStore } = await import("../tasks-store");
    const controller = new AbortController();
    tasksStore.register({
      taskId: "t1",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "p",
      conversationId: "conv1",
      targetWindowId: 100,
      controller,
      startedAt: 1,
    });
    const addedTick = (port.posted as { tasks: unknown[] }[]).at(-1);
    expect(addedTick?.tasks).toHaveLength(1);

    tasksStore.clear("t1");
    const removedTick = (port.posted as { tasks: unknown[] }[]).at(-1);
    expect(removedTick?.tasks).toHaveLength(0);
  });
});
