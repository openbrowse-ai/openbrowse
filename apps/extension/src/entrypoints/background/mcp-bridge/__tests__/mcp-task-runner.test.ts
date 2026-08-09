import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartRunArgs, StartRunDeps, RunControl } from "@/entrypoints/background/agent-host/run";

/**
 * `runMcpTask` is the SW-side entry point invoked by MCP RPC handlers
 * (Tasks 11-14) when a host requests an agent task. It:
 *
 *   1. Creates a fresh chat-db conversation tagged `source="mcp"` with
 *      the host name, the target window id, and the space id.
 *   2. Pins the SW-realm module-scope caches (agent context / window /
 *      color) BEFORE startRun fires so the first tool call sees the
 *      correct window and conversation.
 *   3. Delegates to the agent-host's `startRun` with `origin="mcp"`,
 *      injecting MCP-specific transport / persister / snapshot
 *      factories. The transport wrapper tees `tool-input-start`,
 *      `tool-output-available`, and `text-delta` chunks into the
 *      caller-provided `emitEvent` so the WS bridge can forward them
 *      as MCP notifications.
 *   4. Returns a control whose `completion` resolves when the run
 *      reaches a terminal state. External aborts via the args'
 *      `abortSignal` are routed into `control.handle.abort.abort()`.
 *
 * These tests cover the contract; the integration with the live
 * agent-host loop is exercised by `run.test.ts`.
 */

const startRunMock = vi.fn();
const registry = {
  register: vi.fn(),
  get: vi.fn(),
  release: vi.fn(),
  list: vi.fn(() => []),
};

function fakeRunControl(opts: { conversationId: string; completion?: Promise<void> }): RunControl {
  const abort = new AbortController();
  return {
    handle: {
      conversationId: opts.conversationId,
      abort,
      startedAt: Date.now(),
      status: "running",
      subscribers: new Set(),
    },
    completion: opts.completion ?? Promise.resolve(),
  };
}

vi.mock("@/entrypoints/background/agent-host/run", () => ({
  startRun: (...args: unknown[]) => startRunMock(...args),
  stopRun: vi.fn(),
}));

vi.mock("@/entrypoints/background/agent-host/registry", () => ({
  agentHostRegistry: registry,
  createRegistry: () => registry,
}));

// Default persister: agent-host's `AssistantStreamPersister` has
// `persist(message)` + `final()` (NOT `persistStream`). Mock matches.
vi.mock("@/entrypoints/background/agent-host/persist-stream", () => ({
  createAssistantStreamPersisterDefault: vi.fn((_cid: string) => ({
    persist: vi.fn(async () => {}),
    final: vi.fn(() => ({ finalText: "", messageCount: 0, transcript: [] })),
  })),
}));

vi.mock("@/lib/agent/agent-transport", () => ({
  setAgentContext: vi.fn(),
  setAgentWindow: vi.fn(),
  setAgentColor: vi.fn(),
  createAgentTransport: vi.fn(async () => ({
    sendMessages: vi.fn(async () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    ),
  })),
}));

vi.mock("@/lib/storage", () => ({
  storage: {
    getSettings: vi.fn(async () => ({})),
    getAgentSettings: vi.fn(async () => ({ agentModel: "anthropic:claude" })),
  },
}));

vi.mock("@/lib/chat-db", () => {
  const conversations: Record<string, Record<string, unknown>> = {};
  return {
    chatDb: {
      createConversation: vi.fn(async (input: Record<string, unknown>) => {
        conversations[input.id as string] = input;
      }),
      getConversation: vi.fn(async (id: string) => conversations[id]),
      saveMessage: vi.fn(async () => {}),
      updateConversation: vi.fn(async () => {}),
    },
    __conversations: conversations,
  };
});

beforeEach(async () => {
  startRunMock.mockReset();
  startRunMock.mockImplementation((args: StartRunArgs) =>
    fakeRunControl({ conversationId: args.conversationId }),
  );
  registry.register.mockReset();
  registry.release.mockReset();
  // Reset createAgentTransport call history so tests asserting on
  // .mock.calls don't read stale invocations from prior tests
  // (B23 fix — was previously cleared mid-test, which is fragile
  // if a future re-order moves an asserting test before the clear).
  const transportMod = await import("@/lib/agent/agent-transport");
  (
    transportMod.createAgentTransport as unknown as {
      mockClear: () => void;
    }
  ).mockClear();
});

afterEach(() => {
  vi.resetModules();
});

describe("mcp-task-runner", () => {
  it("creates a conversation with source='mcp', mcpHostName, originWindowId, spaceId", async () => {
    const { runMcpTask } = await import("../mcp-task-runner");
    await runMcpTask({
      taskId: "t1",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "summarize unread",
      targetWindowId: 100,
      spaceId: null,
      abortSignal: new AbortController().signal,
      emitEvent: vi.fn(),
    });
    const chatDbModule = (await import("@/lib/chat-db")) as unknown as {
      __conversations: Record<string, { source: string; mcpHostName: string; originWindowId: number; spaceId: string | null }>;
    };
    const ids = Object.keys(chatDbModule.__conversations);
    expect(ids).toHaveLength(1);
    const conv = chatDbModule.__conversations[ids[0]];
    expect(conv.source).toBe("mcp");
    expect(conv.mcpHostName).toBe("Cursor");
    expect(conv.originWindowId).toBe(100);
    expect(conv.spaceId).toBeNull();
  });

  it("pins window + color + context on the SW caches before startRun", async () => {
    const transport = await import("@/lib/agent/agent-transport");
    const { runMcpTask } = await import("../mcp-task-runner");
    await runMcpTask({
      taskId: "t1",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "x",
      targetWindowId: 100,
      spaceId: null,
      abortSignal: new AbortController().signal,
      emitEvent: vi.fn(),
    });
    expect(transport.setAgentContext).toHaveBeenCalled();
    const calls = (transport.setAgentContext as unknown as { mock: { calls: [string][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const cid = calls[0][0];
    expect(transport.setAgentWindow).toHaveBeenCalledWith(cid, 100);
    expect(transport.setAgentColor).toHaveBeenCalledWith(cid, null);
  });

  it("invokes startRun with origin='mcp' and the freshly-created conversationId", async () => {
    const { runMcpTask } = await import("../mcp-task-runner");
    await runMcpTask({
      taskId: "t1",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "x",
      targetWindowId: 100,
      spaceId: null,
      abortSignal: new AbortController().signal,
      emitEvent: vi.fn(),
    });
    expect(startRunMock).toHaveBeenCalledOnce();
    const [args, deps] = startRunMock.mock.calls[0] as [StartRunArgs, StartRunDeps];
    expect(args.origin).toBe("mcp");
    expect(typeof args.conversationId).toBe("string");
    expect(args.conversationId.length).toBeGreaterThan(0);
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0].role).toBe("user");
    expect(deps).toBeDefined();
    expect(deps.buildTransport).toBeDefined();
    expect(deps.buildPersister).toBeDefined();
    expect(deps.buildSnapshotBroadcaster).toBeDefined();
  });

  it("returns a control whose completion resolves when startRun's completion resolves", async () => {
    const { runMcpTask } = await import("../mcp-task-runner");
    let resolved = false;
    startRunMock.mockImplementation((args: StartRunArgs) =>
      fakeRunControl({
        conversationId: args.conversationId,
        completion: new Promise<void>((r) => setTimeout(() => {
          resolved = true;
          r();
        }, 10)),
      }),
    );
    const { completion } = await runMcpTask({
      taskId: "t1",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "x",
      targetWindowId: 100,
      spaceId: null,
      abortSignal: new AbortController().signal,
      emitEvent: vi.fn(),
    });
    await completion;
    expect(resolved).toBe(true);
  });

  it("propagates external abort by linking the abortSignal into the run's RunHandle", async () => {
    const { runMcpTask } = await import("../mcp-task-runner");
    const externalAbort = new AbortController();
    let runHandleAbortFired = false;
    startRunMock.mockImplementation((args: StartRunArgs) => {
      const control = fakeRunControl({ conversationId: args.conversationId });
      control.handle.abort.signal.addEventListener("abort", () => {
        runHandleAbortFired = true;
      });
      return control;
    });
    await runMcpTask({
      taskId: "t1",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "x",
      targetWindowId: 100,
      spaceId: null,
      abortSignal: externalAbort.signal,
      emitEvent: vi.fn(),
    });
    externalAbort.abort();
    expect(runHandleAbortFired).toBe(true);
  });

  it("tees chunk stream through buildTransport to emit task events", async () => {
    const { runMcpTask } = await import("../mcp-task-runner");
    const events: unknown[] = [];
    const emitEvent = vi.fn((e) => events.push(e));

    // Capture the deps so we can drive `buildTransport` ourselves.
    let capturedDeps: StartRunDeps | null = null;
    let capturedArgs: StartRunArgs | null = null;
    startRunMock.mockImplementation((args: StartRunArgs, deps: StartRunDeps) => {
      capturedDeps = deps;
      capturedArgs = args;
      return fakeRunControl({ conversationId: args.conversationId });
    });

    // Override createAgentTransport to return chunks that simulate a run.
    const transportMod = await import("@/lib/agent/agent-transport");
    (transportMod.createAgentTransport as unknown as { mockImplementation: (fn: () => unknown) => void }).mockImplementation(
      async () => ({
        sendMessages: async () =>
          new ReadableStream({
            start(controller) {
              // Note: `tool-output-available` does NOT carry `toolName`
              // in the SDK chunk type — only `toolCallId` + `output`.
              // The runner's chunk-tee recovers the name via a
              // `toolCallId -> toolName` map populated on
              // `tool-input-start`. We deliberately emit two distinct
              // tool calls so we can also assert the per-run step
              // counter increments.
              controller.enqueue({ type: "tool-input-start", toolCallId: "tc1", toolName: "navigate" });
              controller.enqueue({ type: "text-delta", id: "m1", delta: "Hello " });
              controller.enqueue({ type: "tool-output-available", toolCallId: "tc1", output: "ok" });
              controller.enqueue({ type: "text-delta", id: "m1", delta: "world" });
              controller.enqueue({ type: "tool-input-start", toolCallId: "tc2", toolName: "screenshot" });
              controller.enqueue({ type: "tool-output-available", toolCallId: "tc2", output: "ok2" });
              controller.close();
            },
          }),
      }),
    );

    await runMcpTask({
      taskId: "t1",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "x",
      targetWindowId: 100,
      spaceId: null,
      abortSignal: new AbortController().signal,
      emitEvent,
    });

    // Drive the transport: simulates what startRun's IIFE would do.
    expect(capturedDeps).not.toBeNull();
    const handle = { conversationId: capturedArgs!.conversationId, abort: new AbortController(), startedAt: 0, status: "running" as const, subscribers: new Set<chrome.runtime.Port>() };
    const transport = capturedDeps!.buildTransport(capturedArgs!, handle);
    const stream = await transport.sendMessages({ messages: capturedArgs!.messages });
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // Should have emitted step-start, text x2, step-finish for each
    // of the two tool calls.
    const kinds = events.map((e) => (e as { kind: string }).kind);
    expect(kinds).toContain("step-start");
    expect(kinds).toContain("step-finish");
    expect(kinds.filter((k) => k === "text").length).toBe(2);

    // step-finish must recover toolName via the toolCallId map —
    // a hard-coded "?" would mean we regressed the per-run map.
    const stepFinishes = events.filter(
      (e) => (e as { kind: string }).kind === "step-finish",
    ) as { kind: "step-finish"; step: number; toolName: string }[];
    expect(stepFinishes).toHaveLength(2);
    expect(stepFinishes[0].toolName).toBe("navigate");
    expect(stepFinishes[1].toolName).toBe("screenshot");

    // step counter must increment across multiple tool-input-start chunks.
    const stepStarts = events.filter(
      (e) => (e as { kind: string }).kind === "step-start",
    ) as { kind: "step-start"; step: number; toolName: string }[];
    expect(stepStarts).toHaveLength(2);
    expect(stepStarts[0].step).toBe(1);
    expect(stepStarts[0].toolName).toBe("navigate");
    expect(stepStarts[1].step).toBe(2);
    expect(stepStarts[1].toolName).toBe("screenshot");
  });

  it("re-emits step-start with populated argsPreview on tool-input-available chunks", async () => {
    const { runMcpTask } = await import("../mcp-task-runner");
    const events: unknown[] = [];
    const emitEvent = vi.fn((e) => events.push(e));

    let capturedDeps: StartRunDeps | null = null;
    let capturedArgs: StartRunArgs | null = null;
    startRunMock.mockImplementation((args: StartRunArgs, deps: StartRunDeps) => {
      capturedDeps = deps;
      capturedArgs = args;
      return fakeRunControl({ conversationId: args.conversationId });
    });

    const transportMod = await import("@/lib/agent/agent-transport");
    (
      transportMod.createAgentTransport as unknown as {
        mockImplementation: (fn: () => unknown) => void;
      }
    ).mockImplementation(async () => ({
      sendMessages: async () =>
        new ReadableStream({
          start(controller) {
            // SDK emits tool-input-start first (no args yet), then
            // tool-input-available once the input has been fully
            // streamed. We expect TWO step-start events: the first
            // with empty argsPreview, the second with the JSON args.
            controller.enqueue({
              type: "tool-input-start",
              toolCallId: "tc1",
              toolName: "navigate",
            });
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: "tc1",
              toolName: "navigate",
              input: { url: "https://example.com/page" },
            });
            controller.enqueue({
              type: "tool-output-available",
              toolCallId: "tc1",
              output: "ok",
            });
            controller.close();
          },
        }),
    }));

    await runMcpTask({
      taskId: "t-args",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "x",
      targetWindowId: 100,
      spaceId: null,
      abortSignal: new AbortController().signal,
      emitEvent,
    });

    const handle = {
      conversationId: capturedArgs!.conversationId,
      abort: new AbortController(),
      startedAt: 0,
      status: "running" as const,
      subscribers: new Set<chrome.runtime.Port>(),
    };
    const transport = capturedDeps!.buildTransport(capturedArgs!, handle);
    const stream = await transport.sendMessages({
      messages: capturedArgs!.messages,
    });
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const stepStarts = events.filter(
      (e) => (e as { kind: string }).kind === "step-start",
    ) as { kind: "step-start"; toolName: string; argsPreview: string }[];
    expect(stepStarts).toHaveLength(2);
    expect(stepStarts[0].argsPreview).toBe("");
    expect(stepStarts[1].toolName).toBe("navigate");
    expect(stepStarts[1].argsPreview).toBe(
      '{"url":"https://example.com/page"}',
    );
  });

  it("calls createAgentTransport with headless={autoApprove:true, allowDelegate:true} so MCP runs auto-approve gated tools and can spawn subagents", async () => {
    // The MCP conversation has no UI surface to render an approval
    // prompt on; the host's OAuth grant + per-host policy + per-task
    // confirmation prompt are the consent for the run. The runner must
    // pass `headless: { autoApprove: true, allowDelegate: true }` so:
    //   - autoApprove: true → the agent's approval-gated tools
    //     (closeTabs, executePython, executeOnPage, Write, Edit,
    //     Delete, install_skill, create_skill, deleteArtifact,
    //     proposePlan) execute instead of stalling
    //     and being healed to `output-denied`.
    //   - allowDelegate: true → the tool-set filter keeps `delegate`
    //     available (it's dropped by default for headless scheduled
    //     runs, but MCP runs are full agent runs and need fan-out).
    const { runMcpTask } = await import("../mcp-task-runner");

    let capturedDeps: StartRunDeps | null = null;
    let capturedArgs: StartRunArgs | null = null;
    startRunMock.mockImplementation((args: StartRunArgs, deps: StartRunDeps) => {
      capturedDeps = deps;
      capturedArgs = args;
      return fakeRunControl({ conversationId: args.conversationId });
    });

    const transportMod = await import("@/lib/agent/agent-transport");
    const createAgentTransportMock =
      transportMod.createAgentTransport as unknown as ReturnType<typeof vi.fn>;
    createAgentTransportMock.mockClear();

    await runMcpTask({
      taskId: "t-headless",
      clientId: "c1",
      hostName: "Cursor",
      prompt: "do the thing",
      targetWindowId: 100,
      spaceId: null,
      abortSignal: new AbortController().signal,
      emitEvent: vi.fn(),
    });

    // Drive the transport once — that's when createAgentTransport is
    // invoked (it's lazy, deferred until the first sendMessages call).
    const handle = {
      conversationId: capturedArgs!.conversationId,
      abort: new AbortController(),
      startedAt: 0,
      status: "running" as const,
      subscribers: new Set<chrome.runtime.Port>(),
    };
    const transport = capturedDeps!.buildTransport(capturedArgs!, handle);
    await transport.sendMessages({ messages: capturedArgs!.messages });

    expect(createAgentTransportMock).toHaveBeenCalledOnce();
    // Behavioural assertion (B14): use expect.objectContaining
    // against the headless argument's shape rather than a
    // positional-index check. If a future signature change inserts
    // a parameter at index 6, this assertion still detects "no
    // call had a headless arg with autoApprove + allowDelegate" by
    // searching every call's arg list.
    const sawHeadlessArg = createAgentTransportMock.mock.calls.some((call) =>
      call.some(
        (arg) =>
          typeof arg === "object" &&
          arg !== null &&
          (arg as { autoApprove?: unknown }).autoApprove === true &&
          (arg as { allowDelegate?: unknown }).allowDelegate === true,
      ),
    );
    expect(sawHeadlessArg).toBe(true);
  });
});

describe("preflightAgent", () => {
  /**
   * Helper: re-stub `storage` for one test. The default mock at the
   * top of the file already returns `agentModel: "anthropic:claude"`;
   * we override per-case here for the failure-mode cases.
   *
   * `providerConfigs` defaults to `{}` so the "missing required fields"
   * branch needs an explicit override to a populated record.
   */
  async function withStorage(overrides: {
    agentModel?: string;
    providerConfigs?: Record<string, Record<string, string>>;
  }) {
    const storageMod = await import("@/lib/storage");
    (storageMod.storage.getAgentSettings as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      agentModel: overrides.agentModel ?? "anthropic:claude",
    });
    (storageMod.storage.getSettings as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      providerConfigs: overrides.providerConfigs ?? {},
    });
  }

  /**
   * Mock the providers registry. The real one is large; the helper
   * stubs only the shape `preflightAgent` reads: each provider has
   * `id`, `models[].id`, and an optional `configSchema`.
   */
  function mockProviders(
    providers: Array<{
      id: string;
      models: Array<{ id: string }>;
      configSchema?: Array<{ key: string; required: boolean }>;
    }>,
  ) {
    vi.doMock("@/registry/providers", () => ({ providers }));
  }

  afterEach(() => {
    vi.doUnmock("@/registry/providers");
  });

  it("returns ok when the agent model is configured and its provider has required fields", async () => {
    mockProviders([
      {
        id: "anthropic",
        models: [{ id: "claude" }],
        configSchema: [{ key: "apiKey", required: true }],
      },
    ]);
    await withStorage({
      agentModel: "anthropic:claude",
      providerConfigs: { anthropic: { apiKey: "sk-xyz" } },
    });
    const { preflightAgent } = await import("../mcp-task-runner");
    const r = await preflightAgent();
    expect(r.ok).toBe(true);
  });

  it("returns agent_not_configured when agentModel is empty, listing configured providers", async () => {
    mockProviders([]);
    await withStorage({
      agentModel: "",
      providerConfigs: { openai: { apiKey: "sk-xyz" }, anthropic: {} },
    });
    const { preflightAgent } = await import("../mcp-task-runner");
    const r = await preflightAgent();
    expect(r).toMatchObject({ ok: false, code: "agent_not_configured" });
    // The diagnostic message must surface the configured providers so
    // a user who's added a provider but not picked a model
    // immediately knows what step they missed.
    if (!r.ok) {
      expect(r.message).toContain("openai");
      expect(r.message).toContain("anthropic");
    }
  });

  it("returns agent_not_configured with a different message when NO providers are configured at all", async () => {
    mockProviders([]);
    await withStorage({
      agentModel: "",
      providerConfigs: {},
    });
    const { preflightAgent } = await import("../mcp-task-runner");
    const r = await preflightAgent();
    expect(r).toMatchObject({ ok: false, code: "agent_not_configured" });
    if (!r.ok) {
      // The "no providers either" branch points the user at the
      // provider-setup step first, not the model picker.
      expect(r.message).toContain("add a provider");
    }
  });

  it("returns agent_provider_unknown when the provider id is not registered", async () => {
    mockProviders([
      { id: "openai", models: [{ id: "gpt-4" }] },
    ]);
    await withStorage({ agentModel: "anthropic:claude" });
    const { preflightAgent } = await import("../mcp-task-runner");
    const r = await preflightAgent();
    expect(r).toMatchObject({ ok: false, code: "agent_provider_unknown" });
  });

  it("returns agent_provider_misconfigured when a required field is missing", async () => {
    mockProviders([
      {
        id: "anthropic",
        models: [{ id: "claude" }],
        configSchema: [
          { key: "apiKey", required: true },
          { key: "optionalThing", required: false },
        ],
      },
    ]);
    await withStorage({
      agentModel: "anthropic:claude",
      providerConfigs: { anthropic: {} }, // no apiKey
    });
    const { preflightAgent } = await import("../mcp-task-runner");
    const r = await preflightAgent();
    expect(r).toMatchObject({ ok: false, code: "agent_provider_misconfigured" });
    if (!r.ok) {
      expect(r.message).toContain("apiKey");
    }
  });

  it("accepts legacy flat model ids that match by model id alone", async () => {
    mockProviders([
      {
        id: "anthropic",
        models: [{ id: "claude" }],
        // No required fields at all.
        configSchema: [],
      },
    ]);
    await withStorage({
      agentModel: "claude", // legacy flat id, no "provider:" prefix
    });
    const { preflightAgent } = await import("../mcp-task-runner");
    const r = await preflightAgent();
    expect(r.ok).toBe(true);
  });
});
