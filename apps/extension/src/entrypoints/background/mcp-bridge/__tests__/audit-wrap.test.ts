import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditDbEntry } from "@/lib/mcp-bridge-audit-db";

// Mock the audit DB at the module-graph level. Hoisted by vitest above
// the dynamic `import("@/lib/mcp-bridge-audit-db")` inside dispatchRpc.
const appendMock = vi.fn(async (_entry: AuditDbEntry) => undefined);
vi.mock("@/lib/mcp-bridge-audit-db", () => ({
  auditDb: {
    append: appendMock,
    list: vi.fn(),
    clearOlderThan: vi.fn(),
    _resetForTests: vi.fn(),
  },
}));

// Stub the task handler's confirmation gate so the "denied" outcome
// path is reachable without standing up the consent UI.
const mockAwaitConfirmation = vi.fn();
vi.mock("../confirmation", () => ({
  awaitConfirmation: mockAwaitConfirmation,
}));

// 2026-06-29 async dispatch: the task handler now resolves the host
// policy synchronously via `resolveConfirmation` instead of relying
// solely on `awaitConfirmation`. Mock both so we can drive the
// host_blocked + denied scenarios.
const mockResolveConfirmation = vi.fn();
vi.mock("@/lib/mcp-host-policy", () => ({
  resolveConfirmation: mockResolveConfirmation,
}));

// Stub runMcpTask too — its module pulls in agent transport which is
// not needed for the denied path (we abort before reaching it).
// `preflightAgent` is mocked to always pass so we hit the consent
// path being tested instead of failing pre-emptively.
const mockRunMcpTask = vi.fn();
const mockPreflightAgent = vi.fn(async () => ({ ok: true as const }));
vi.mock("../mcp-task-runner", () => ({
  runMcpTask: mockRunMcpTask,
  preflightAgent: mockPreflightAgent,
}));

beforeEach(() => {
  appendMock.mockReset();
  appendMock.mockResolvedValue(undefined);
  mockAwaitConfirmation.mockReset();
  mockRunMcpTask.mockReset();
  mockResolveConfirmation.mockReset();
  // Default: auto-allow. Tests that need other outcomes override.
  mockResolveConfirmation.mockResolvedValue("auto");

  // Minimal `chrome` surface needed by get_context (windows.getAll,
  // tabs.query, storage.local.get), read_page's fallback path
  // (windows.getCurrent, tabs.get), and task's resolveTargetWindow
  // (windows.getAll, tabs.query).
  (globalThis as any).chrome = {
    windows: {
      getAll: vi.fn(async () => [{ id: 1, focused: true, incognito: false }]),
      getCurrent: vi.fn(async () => ({ id: 1, focused: true })),
      get: vi.fn(async (id: number) => ({ id, focused: false })),
      create: vi.fn(async () => ({ id: 1 })),
    },
    tabs: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => {
        throw new Error("no such tab");
      }),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    runtime: { getManifest: () => ({ version: "0.0.0-test" }) },
  };
});

afterEach(() => {
  delete (globalThis as any).chrome;
  vi.resetModules();
});

describe("RPC audit wrap", () => {
  it("records ok outcome on successful dispatch", async () => {
    const { dispatchRpc } = await import("../index");
    const sent: string[] = [];

    await dispatchRpc(
      {
        type: "rpc",
        id: "r1",
        method: "get_context",
        params: {},
        hostInfo: { name: "Cursor", version: "1.0.0" },
      } as never,
      (data: string) => sent.push(data),
      { sub: "c1", client_name: "Cursor" },
    );

    expect(appendMock).toHaveBeenCalledTimes(1);
    const row = appendMock.mock.calls[0][0];
    expect(row).toMatchObject({
      clientId: "c1",
      hostName: "Cursor",
      method: "get_context",
      outcome: "ok",
    });
    expect(typeof row.seq).toBe("number");
    expect(typeof row.ts).toBe("number");
    expect(typeof row.durationMs).toBe("number");
    expect(row.errorCode).toBeUndefined();

    // The result envelope is still sent after the audit row.
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({ type: "rpc-result", id: "r1" });
  });

  it("records error outcome (non-denial) when a handler throws", async () => {
    const { dispatchRpc } = await import("../index");
    const sent: string[] = [];

    // read_page with a bogus tabId → chrome.tabs.get throws → handler
    // throws Error("tab_not_found"). No `code` property, so the wrap
    // defaults the audit errorCode to "internal_error" and the outcome
    // to "error" (not "denied").
    await dispatchRpc(
      {
        type: "rpc",
        id: "r2",
        method: "read_page",
        params: { tabId: 9999 },
        hostInfo: { name: "h", version: "" },
      } as never,
      (data: string) => sent.push(data),
      { sub: "c1", client_name: "h" },
    );

    expect(appendMock).toHaveBeenCalledTimes(1);
    const row = appendMock.mock.calls[0][0];
    expect(row).toMatchObject({
      clientId: "c1",
      hostName: "h",
      method: "read_page",
      outcome: "error",
      errorCode: "internal_error",
    });

    expect(sent).toHaveLength(1);
    const env = JSON.parse(sent[0]);
    expect(env.type).toBe("rpc-error");
    expect(env.id).toBe("r2");
  });

  it("records ok outcome for task even when async runner later denies (audit captures the RPC, not the run outcome)", async () => {
    // 2026-06-29 async dispatch: `task` returns
    // `{status: awaiting_confirmation, taskId}` synchronously even
    // when the user will later deny. The async deny path mutates
    // tasksStore but does not retroactively change the audit row.
    // The audit DB therefore records the RPC as `ok` — exactly the
    // semantics callers of `task` need for "did the dispatch
    // succeed?" reporting.
    mockResolveConfirmation.mockResolvedValue("prompt");
    // The awaiter never resolves in this test — irrelevant, the
    // RPC returns before it does.
    mockAwaitConfirmation.mockReturnValue(new Promise(() => {}));
    mockRunMcpTask.mockResolvedValue({
      conversationId: "conv1",
      completion: Promise.resolve(),
      handle: {
        conversationId: "conv1",
        abort: new AbortController(),
        startedAt: 0,
        status: "completed",
        subscribers: new Set(),
      },
    });

    const { dispatchRpc } = await import("../index");
    const sent: string[] = [];

    await dispatchRpc(
      {
        type: "rpc",
        id: "r3",
        method: "task",
        params: { prompt: "anything" },
        hostInfo: { name: "h", version: "" },
      } as never,
      (data: string) => sent.push(data),
      { sub: "c1", client_name: "h" },
    );

    expect(appendMock).toHaveBeenCalledTimes(1);
    const row = appendMock.mock.calls[0][0];
    expect(row).toMatchObject({
      clientId: "c1",
      method: "task",
      outcome: "ok",
    });

    // Envelope is rpc-result (synchronous dispatch success).
    const envelopes = sent.map((s) => JSON.parse(s));
    const resultEnv = envelopes.find((e) => e.type === "rpc-result");
    expect(resultEnv).toBeDefined();
    expect(resultEnv.result.status).toBe("awaiting_confirmation");
  });

  it("records denied outcome for host_blocked error code", async () => {
    // host_blocked still surfaces synchronously: the new task
    // handler calls `resolveConfirmation` up front and throws
    // RpcError("host_blocked", ...) without registering anything in
    // tasksStore.
    mockResolveConfirmation.mockResolvedValue("host_blocked");

    const { dispatchRpc } = await import("../index");
    const sent: string[] = [];

    await dispatchRpc(
      {
        type: "rpc",
        id: "r4",
        method: "task",
        params: { prompt: "anything" },
        hostInfo: { name: "h", version: "" },
      } as never,
      (data: string) => sent.push(data),
      { sub: "c1", client_name: "h" },
    );

    expect(appendMock).toHaveBeenCalledTimes(1);
    const row = appendMock.mock.calls[0][0];
    expect(row.outcome).toBe("denied");
    expect(row.errorCode).toBe("host_blocked");
  });
});
