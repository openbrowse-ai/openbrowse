import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the four message cases added in Phase 2 Task 15:
 *  - MCP_BRIDGE_LIST_ACTIVE_TASKS
 *  - MCP_BRIDGE_LIST_PENDING_PROMPTS
 *  - MCP_BRIDGE_CONFIRM_TASK
 *  - MCP_BRIDGE_CANCEL_TASK
 *
 * We exercise the dispatcher end-to-end (it lazy-imports tasksStore and
 * confirmation), which gives us realistic coverage of the wire shape
 * the Background Tasks panel relies on.
 */

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.resetModules();
});

describe("mcp-bridge-messages — LIST_ACTIVE_TASKS", () => {
  it("returns a serializable summary of each registered task (no controller leak)", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t1",
      clientId: "client-secret-do-not-leak",
      hostName: "Cursor",
      prompt: "summarize",
      conversationId: "c1",
      targetWindowId: 100,
      spaceId: "space-1",
      controller: new AbortController(),
      startedAt: 1000,
      taskTitlePreview: "Summarize unread",
    });

    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    const responses: unknown[] = [];
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_LIST_ACTIVE_TASKS" },
      (r) => responses.push(r),
    );

    expect(responses).toHaveLength(1);
    const resp = responses[0] as {
      ok: boolean;
      tasks: Array<Record<string, unknown>>;
    };
    expect(resp.ok).toBe(true);
    expect(resp.tasks).toEqual([
      {
        taskId: "t1",
        hostName: "Cursor",
        prompt: "summarize",
        targetWindowId: 100,
        spaceId: "space-1",
        startedAt: 1000,
        taskTitlePreview: "Summarize unread",
      },
    ]);
    // Defense-in-depth: clientId and the AbortController must not bleed
    // through to the UI. The summary is the only thing the panel sees.
    expect(resp.tasks[0]).not.toHaveProperty("clientId");
    expect(resp.tasks[0]).not.toHaveProperty("controller");
  });

  it("emits null for missing spaceId/taskTitlePreview so the UI never sees undefined", async () => {
    const { tasksStore } = await import("../tasks-store");
    tasksStore.register({
      taskId: "t2",
      clientId: "c",
      hostName: "h",
      prompt: "p",
      conversationId: "x",
      targetWindowId: 0,
      controller: new AbortController(),
      startedAt: 0,
    });
    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean; tasks: Array<Record<string, unknown>> } | null =
      null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_LIST_ACTIVE_TASKS" },
      (r) => {
        resp = r as typeof resp;
      },
    );
    expect(resp!.tasks[0].spaceId).toBeNull();
    expect(resp!.tasks[0].taskTitlePreview).toBeNull();
  });
});

describe("mcp-bridge-messages — CANCEL_TASK", () => {
  it("returns ok:true when the task exists and aborts it", async () => {
    const { tasksStore } = await import("../tasks-store");
    const controller = new AbortController();
    const aborted = new Promise<void>((r) =>
      controller.signal.addEventListener("abort", () => r()),
    );
    tasksStore.register({
      taskId: "t-cancel",
      clientId: "c",
      hostName: "h",
      prompt: "p",
      conversationId: "x",
      targetWindowId: 0,
      controller,
      startedAt: 0,
    });

    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean } | null = null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_CANCEL_TASK", taskId: "t-cancel" },
      (r) => {
        resp = r as { ok: boolean };
      },
    );
    expect(resp!.ok).toBe(true);
    await aborted;
    // 2026-06-29 async dispatch: cancel keeps the row in
    // `cancelled` state for TTL. Assert the transition, not eviction.
    expect(tasksStore.get("t-cancel")?.status).toBe("cancelled");
  });

  it("returns ok:false for an unknown taskId", async () => {
    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean } | null = null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_CANCEL_TASK", taskId: "does-not-exist" },
      (r) => {
        resp = r as { ok: boolean };
      },
    );
    expect(resp!.ok).toBe(false);
  });
});

describe("mcp-bridge-messages — CONFIRM_TASK", () => {
  it("returns ok:false for an unknown promptId (no pending entry)", async () => {
    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean } | null = null;
    await handleMcpBridgeMessage(
      {
        type: "MCP_BRIDGE_CONFIRM_TASK",
        promptId: "unknown",
        outcome: "allow",
      },
      (r) => {
        resp = r as { ok: boolean };
      },
    );
    expect(resp!.ok).toBe(false);
  });
});

describe("mcp-bridge-messages — LIST_PENDING_PROMPTS", () => {
  it("returns an empty array when nothing is pending", async () => {
    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean; prompts: unknown[] } | null = null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_LIST_PENDING_PROMPTS" },
      (r) => {
        resp = r as typeof resp;
      },
    );
    expect(resp!.ok).toBe(true);
    expect(resp!.prompts).toEqual([]);
  });
});

describe("mcp-bridge-messages — REVOKE_HOST", () => {
  it("sets local policy to blocked and forwards revoke-host over WS when connected", async () => {
    // Phase 3 / Task 11: revocation has two effects — the local policy
    // flip (always) and a `revoke-host` WS message to the broker (best
    // effort, only when the bridge is connected). The broker uses the
    // WS message to delete refresh tokens.
    const setPolicy = vi.fn(async () => {});
    vi.doMock("@/lib/mcp-host-policy", () => ({ setPolicy }));

    const send = vi.fn();
    vi.doMock("../mcp-bridge/boot", () => ({
      getCurrentWs: () => ({ send }),
    }));

    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean } | null = null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_REVOKE_HOST", clientId: "c-revoke" },
      (r) => {
        resp = r as { ok: boolean };
      },
    );
    expect(resp!.ok).toBe(true);
    expect(setPolicy).toHaveBeenCalledWith("c-revoke", "blocked");
    expect(send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(send.mock.calls[0][0] as string);
    expect(sent).toEqual({ type: "revoke-host", clientId: "c-revoke" });

    vi.doUnmock("@/lib/mcp-host-policy");
    vi.doUnmock("../mcp-bridge/boot");
  });

  it("still reports ok and applies the local block when no WS is connected", async () => {
    const setPolicy = vi.fn(async () => {});
    vi.doMock("@/lib/mcp-host-policy", () => ({ setPolicy }));

    vi.doMock("../mcp-bridge/boot", () => ({
      // null = bridge isn't booted (e.g. extension startup in progress).
      getCurrentWs: () => null,
    }));

    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean } | null = null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_REVOKE_HOST", clientId: "c-offline" },
      (r) => {
        resp = r as { ok: boolean };
      },
    );
    expect(resp!.ok).toBe(true);
    expect(setPolicy).toHaveBeenCalledWith("c-offline", "blocked");

    vi.doUnmock("@/lib/mcp-host-policy");
    vi.doUnmock("../mcp-bridge/boot");
  });
});

describe("mcp-bridge-messages — CLEAR_TRUST + FORCE_RECONNECT + GET_STATUS", () => {
  it("CLEAR_TRUST delegates to clearTrustAndReconnect and returns ok", async () => {
    const clearTrustAndReconnect = vi.fn(async () => {});
    vi.doMock("../mcp-bridge/boot", () => ({
      getStatus: () => ({ kind: "disconnected" }),
      bootMcpBridge: vi.fn(),
      acceptTofu: vi.fn(),
      declineTofu: vi.fn(),
      clearTrustAndReconnect,
      forceReconnectNow: vi.fn(),
    }));
    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean } | null = null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_CLEAR_TRUST" },
      (r) => {
        resp = r as { ok: boolean };
      },
    );
    expect(resp!.ok).toBe(true);
    expect(clearTrustAndReconnect).toHaveBeenCalledTimes(1);
    vi.doUnmock("../mcp-bridge/boot");
  });

  it("FORCE_RECONNECT delegates to forceReconnectNow and returns ok", async () => {
    const forceReconnectNow = vi.fn(async () => {});
    vi.doMock("../mcp-bridge/boot", () => ({
      getStatus: () => ({ kind: "disconnected" }),
      bootMcpBridge: vi.fn(),
      acceptTofu: vi.fn(),
      declineTofu: vi.fn(),
      clearTrustAndReconnect: vi.fn(),
      forceReconnectNow,
    }));
    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean } | null = null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_FORCE_RECONNECT" },
      (r) => {
        resp = r as { ok: boolean };
      },
    );
    expect(resp!.ok).toBe(true);
    expect(forceReconnectNow).toHaveBeenCalledTimes(1);
    vi.doUnmock("../mcp-bridge/boot");
  });

  it("GET_STATUS returns the current BridgeStatus", async () => {
    vi.doMock("../mcp-bridge/boot", () => ({
      getStatus: () => ({ kind: "connected", brokerVersion: "1.0", sessionId: "s", connectedAt: 123 }),
      bootMcpBridge: vi.fn(),
      acceptTofu: vi.fn(),
      declineTofu: vi.fn(),
      clearTrustAndReconnect: vi.fn(),
      forceReconnectNow: vi.fn(),
    }));
    const { handleMcpBridgeMessage } = await import("../mcp-bridge-messages");
    let resp: { ok: boolean; status: { kind: string } } | null = null;
    await handleMcpBridgeMessage(
      { type: "MCP_BRIDGE_GET_STATUS" },
      (r) => {
        resp = r as typeof resp;
      },
    );
    expect(resp!.ok).toBe(true);
    expect(resp!.status.kind).toBe("connected");
    vi.doUnmock("../mcp-bridge/boot");
  });
});
