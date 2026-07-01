/**
 * MCP task runner — SW-side entry point that turns an MCP RPC
 * `task_*` request into an agent-host run.
 *
 * Sits between the WS RPC handlers (Tasks 11-14) and the agent-host
 * machinery (`startRun` in `agent-host/run.ts`). The runner:
 *
 *   1. Creates a chat-db conversation row tagged with `source="mcp"`
 *      and the host's name + the target window. MCP conversations are
 *      filtered out of the user's sidebar by the `source === "mcp"`
 *      predicate (see `Conversation` type in `lib/types.ts`), but they
 *      do appear in the originating window for diagnostics.
 *   2. Pins the SW-realm caches (`setAgentContext`, `setAgentWindow`,
 *      `setAgentColor`) BEFORE delegating to `startRun`, so the very
 *      first tool call sees the correct conversation + window. Without
 *      this step the agent loop would fall back to
 *      `chrome.windows.getCurrent()` and bind a foreign-window tab.
 *   3. Calls `startRun` with `origin="mcp"` and MCP-specific factories:
 *        - `buildTransport`: wraps `createAgentTransport`'s returned
 *          stream to tee `tool-input-start` / `tool-output-available` /
 *          `text-delta` chunks into `emitEvent` for the WS bridge.
 *        - `buildPersister`: the default chat-db persister.
 *        - `buildSnapshotBroadcaster`: a no-op since MCP runs have no
 *          renderer-Port subscribers.
 *   4. Wires the caller-supplied `abortSignal` into
 *      `control.handle.abort`, so a host-initiated cancel reaches the
 *      transport's abort signal and unwinds the stream.
 *
 * Returns an `McpTaskControl` whose `completion` resolves when the run
 * reaches a terminal state (success, error, abort). Caller is
 * responsible for awaiting it and reporting the final assistant text
 * back to the MCP host.
 */

import type { UIMessageChunk } from "ai";
import { chatDb } from "@/lib/chat-db";
import {
  setAgentContext,
  setAgentWindow,
  setAgentColor,
  createAgentTransport,
} from "@/lib/agent/agent-transport";
import { storage } from "@/lib/storage";
import {
  startRun,
  type RunControl,
  type StartRunArgs,
  type RunTransport,
} from "@/entrypoints/background/agent-host/run";
import { agentHostRegistry } from "@/entrypoints/background/agent-host/registry";
import { createAssistantStreamPersisterDefault } from "@/entrypoints/background/agent-host/persist-stream";
import type { SnapshotBroadcaster } from "@/entrypoints/background/agent-host/snapshot-broadcast";
import type { AgentUIMessage } from "@/lib/agent/message-types";

/**
 * Events streamed back to the MCP host via WS `task-event` while the
 * task runs. The handler in Task 11 forwards these as MCP notifications.
 *
 * Kept intentionally shallow (no full UI parts) so the WS payload stays
 * within MCP's notification size budget. Hosts that need the full
 * transcript can fetch it via a separate RPC.
 */
export type McpTaskEvent =
  | { kind: "step-start"; step: number; toolName: string; argsPreview: string }
  | {
      kind: "step-finish";
      step: number;
      toolName: string;
      durationMs: number;
      resultPreview: string;
    }
  | { kind: "text"; text: string }
  | { kind: "error"; message: string };

export interface RunMcpTaskArgs {
  /** MCP host's task id (opaque, used only for diagnostics). */
  taskId: string;
  /** MCP client id (opaque, used only for diagnostics). */
  clientId: string;
  /** Display name of the host (e.g. "Cursor", "Claude Desktop"). */
  hostName: string;
  /** The user-visible prompt the host wants the agent to execute. */
  prompt: string;
  /** Chrome window id the agent should operate in. */
  targetWindowId: number;
  /** Optional space scope; null for "no space". */
  spaceId: string | null;
  /**
   * External abort signal. When aborted, the underlying run's
   * `RunHandle.abort.abort()` is invoked, which cascades into the
   * transport's `AbortSignal` and unwinds the stream.
   */
  abortSignal: AbortSignal;
  /** Per-event callback wired to the WS `task-event` notification. */
  emitEvent: (event: McpTaskEvent) => void;
}

export interface McpTaskControl {
  conversationId: string;
  /** Resolves when the underlying run completes (success / error / abort). */
  completion: Promise<void>;
  /**
   * The underlying `RunHandle` from the agent host. Exposed so callers
   * (notably `handleTask`) can inspect `handle.status` after awaiting
   * `completion` to distinguish success / error / abort terminal
   * states. `startRun` mutates `status` before the completion promise
   * resolves; reading it post-await is race-free.
   */
  handle: import("@/entrypoints/background/agent-host/registry").RunHandle;
}

/**
 * Pre-flight check: verify the user has configured an agent model and
 * that the model's provider has the credentials it needs. Returns
 * `{ ok: true }` when the run will at least be able to instantiate
 * the transport; `{ ok: false, code, message }` otherwise.
 *
 * This is the difference between an MCP host receiving "empty output"
 * (the original Phase 2 bug: `createAgentTransport` returns null, the
 * run terminates early, the chunk stream is empty, `handleTask`
 * returns `output: ""`) and receiving a precise error code that tells
 * the user exactly which OpenBrowse Settings panel to open.
 *
 * The check duplicates a small amount of the resolution logic in
 * `createAgentTransport` so we can attribute the failure correctly.
 * The downside is drift risk — if `createAgentTransport` grows new
 * null-return paths, this check may go stale. The upside is that the
 * MCP host gets actionable diagnostics today; we accept the drift and
 * cover it with tests.
 */
export type PreflightResult =
  | { ok: true }
  | { ok: false; code: PreflightErrorCode; message: string };

export type PreflightErrorCode =
  | "agent_not_configured"
  | "agent_provider_unknown"
  | "agent_provider_misconfigured";

export async function preflightAgent(): Promise<PreflightResult> {
  const settings = await storage.getSettings();
  const agentSettings = await storage.getAgentSettings();
  const agentModel = agentSettings.agentModel;

  // Diagnostic logging. Surfaces to the SW devtools console on every
  // preflight call so a user who sees "agent_not_configured" but
  // believes they configured one can compare the stored state
  // against what they expected. The dump is one-line JSON to keep
  // the console readable.
  const providerIds = Object.keys(settings.providerConfigs ?? {});
  console.log(
    "[mcp-bridge/preflight]",
    JSON.stringify({
      agentModel: agentModel || "(empty)",
      configuredProviders: providerIds,
      hasFavorites: (settings.favoriteModels ?? []).length,
    }),
  );

  if (!agentModel) {
    return {
      ok: false,
      code: "agent_not_configured",
      message: providerIds.length === 0
        ? "OpenBrowse has no agent model selected AND no provider is configured. Open OpenBrowse Settings → Models, add a provider's API key, then pick a model."
        : `OpenBrowse has no agent model selected (providers configured: ${providerIds.join(", ")}). Open the chat panel and use the model picker, or go to Settings → Models, to choose a model before invoking 'task'.`,
    };
  }
  const [maybeProvider, ...modelIdParts] = agentModel.split(":");
  const actualModelId =
    modelIdParts.length > 0 ? modelIdParts.join(":") : agentModel;
  const { providers } = await import("@/registry/providers");
  const provider =
    (modelIdParts.length > 0
      ? providers.find((p) => p.id === maybeProvider)
      : undefined) ??
    providers.find((p) => p.models.some((m) => m.id === actualModelId));
  if (!provider) {
    return {
      ok: false,
      code: "agent_provider_unknown",
      message: `Agent model "${agentModel}" does not match any known provider. Open OpenBrowse Settings → Models and re-select a model.`,
    };
  }
  const config = settings.providerConfigs[provider.id] ?? {};
  const requiredFields = provider.configSchema?.filter((f) => f.required) ?? [];
  const missing = requiredFields.filter((f) => !config[f.key]);
  if (missing.length > 0) {
    return {
      ok: false,
      code: "agent_provider_misconfigured",
      message: `Provider "${provider.id}" (selected model: "${actualModelId}") is missing required configuration (${missing
        .map((f) => f.key)
        .join(", ")}). Open OpenBrowse Settings → Models and complete the provider setup.`,
    };
  }
  return { ok: true };
}

/**
 * Generate a fresh conversation id. Falls back to Math.random when
 * `crypto.getRandomValues` is unavailable (e.g. an unusual test env);
 * the id only needs to be unique within chat-db, not cryptographically
 * strong.
 */
function newConversationId(): string {
  const buf = new Uint8Array(12);
  const c = (globalThis as { crypto?: { getRandomValues(b: Uint8Array): Uint8Array } }).crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return `mcp-${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Per-run mutable state threaded through the chunk-tee so `step-finish`
 * events can recover their `toolName` (the `tool-output-available`
 * chunk type only carries `toolCallId` + `output` — NOT `toolName`),
 * and so `step` reflects the actual ordinal of each tool call rather
 * than a hard-coded zero.
 *
 * Parallel tool calls share a single `stepCounter` — the `step` value
 * on `step-finish` is whatever the counter was at the most recent
 * `step-start`, which is approximate when tools overlap. Acceptable
 * for Phase 2; Phase 3 may correlate step numbers per toolCallId.
 */
interface RunEmitState {
  toolCallNames: Map<string, string>;
  stepCounter: number;
}

/**
 * Inspect a single `UIMessageChunk` and emit any task-events derived
 * from it. Only the chunk types we care about (`tool-input-start`,
 * `tool-output-available`, `text-delta`, `error`) produce events;
 * everything else is silently passed through.
 *
 * Mutates `state` on `tool-input-start` to record the tool name keyed
 * by `toolCallId` and to bump the step counter, so the matching
 * `tool-output-available` can recover both.
 */
/**
 * Compact arg-preview helper for the progress-event tee.
 *
 * Truncates to 200 chars in the middle (head + ellipsis + tail) so
 * both the leading shape (which usually identifies the operation) and
 * trailing data stay visible.
 */
const MAX_ARGS_PREVIEW = 200;
function stringifyArgs(input: unknown): string {
  if (input === undefined || input === null) return "";
  let str: string;
  try {
    str = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    return "";
  }
  if (str.length <= MAX_ARGS_PREVIEW) return str;
  const head = Math.floor((MAX_ARGS_PREVIEW - 1) / 2);
  const tail = MAX_ARGS_PREVIEW - 1 - head;
  return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

function emitForChunk(
  chunk: UIMessageChunk,
  emitEvent: (event: McpTaskEvent) => void,
  state: RunEmitState,
): void {
  const c = chunk as {
    type?: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    delta?: string;
    errorText?: string;
  };
  switch (c.type) {
    case "tool-input-start": {
      state.stepCounter++;
      if (c.toolCallId && c.toolName) {
        state.toolCallNames.set(c.toolCallId, c.toolName);
      }
      emitEvent({
        kind: "step-start",
        step: state.stepCounter,
        toolName: c.toolName ?? "?",
        argsPreview: "",
      });
      return;
    }
    case "tool-input-available":
    case "dynamic-tool-input-available": {
      // The SDK emits this AFTER tool-input-start once the input has
      // been fully streamed/resolved. Re-emit a `step-start` carrying
      // the actual args so the consumer (Activity UI) can show
      // informative progress like "Navigating to example.com".
      // Keying by the existing toolCallId means consumers can detect
      // this as an "args update" rather than a brand-new call.
      const toolName = c.toolCallId
        ? state.toolCallNames.get(c.toolCallId) ?? c.toolName ?? "?"
        : c.toolName ?? "?";
      emitEvent({
        kind: "step-start",
        step: state.stepCounter,
        toolName,
        argsPreview: stringifyArgs(c.input),
      });
      return;
    }
    case "tool-output-available": {
      const toolName = c.toolCallId
        ? state.toolCallNames.get(c.toolCallId) ?? "?"
        : "?";
      emitEvent({
        kind: "step-finish",
        step: state.stepCounter,
        toolName,
        durationMs: 0,
        resultPreview:
          typeof c.output === "string" ? c.output.slice(0, 200) : "",
      });
      return;
    }
    case "text-delta":
      if (typeof c.delta === "string") {
        emitEvent({ kind: "text", text: c.delta });
      }
      return;
    case "error":
      emitEvent({
        kind: "error",
        message: typeof c.errorText === "string" ? c.errorText : "stream error",
      });
      return;
    default:
      return;
  }
}

/**
 * Wrap a `UIMessageChunk` stream to tee task-events out of band while
 * forwarding every chunk unchanged downstream (so `startRun`'s normal
 * fan-out + persistence pipelines still see the full stream).
 */
function teeStreamForEvents(
  source: ReadableStream<UIMessageChunk>,
  emitEvent: (event: McpTaskEvent) => void,
  state: RunEmitState,
): ReadableStream<UIMessageChunk> {
  const transformer: Transformer<UIMessageChunk, UIMessageChunk> = {
    transform(chunk, controller) {
      try {
        emitForChunk(chunk, emitEvent, state);
      } catch {
        // Event emission failures must NOT break the run; swallow
        // and continue forwarding. The WS bridge can log on its end.
      }
      controller.enqueue(chunk);
    },
  };
  return source.pipeThrough(new TransformStream(transformer));
}

export async function runMcpTask(args: RunMcpTaskArgs): Promise<McpTaskControl> {
  const conversationId = newConversationId();
  const now = Date.now();

  // Per-run state for the chunk-tee. The `tool-output-available` chunk
  // type does NOT carry `toolName` (only `toolCallId` + `output`), so
  // we need a per-runner map populated on `tool-input-start` to
  // recover the name when emitting `step-finish`. The step counter
  // bumps on each `tool-input-start` so events carry the actual
  // ordinal of the call rather than a hard-coded zero.
  const emitState: RunEmitState = {
    toolCallNames: new Map(),
    stepCounter: 0,
  };

  // 1. Persist the MCP conversation row up front so any tool that
  //    reads the conversation (e.g. resolveConversationWindowId via
  //    originWindowId) sees a valid row from the first tool call.
  await chatDb.createConversation({
    id: conversationId,
    title: args.prompt.slice(0, 60),
    spaceId: args.spaceId,
    source: "mcp",
    mcpHostName: args.hostName,
    originWindowId: args.targetWindowId,
    createdAt: now,
    updatedAt: now,
  });

  // 2. Pin the SW-realm module-scope caches BEFORE startRun fires.
  //    Without this, the agent loop's window-aware paths
  //    (system-prompt awareness block, listTabs, navigate fallback)
  //    would fall back to `chrome.windows.getCurrent()` for the first
  //    tool call and might bind a foreign-window tab.
  setAgentContext(conversationId);
  setAgentWindow(conversationId, args.targetWindowId);
  setAgentColor(conversationId, null);

  // 3. Build the StartRunArgs. The prompt becomes a single user message.
  const userMessage = {
    id: `mcp-user-${now}`,
    role: "user" as const,
    parts: [{ type: "text" as const, text: args.prompt }],
  } as AgentUIMessage;

  const startArgs: StartRunArgs = {
    conversationId,
    origin: "mcp",
    messages: [userMessage],
  };

  // 4. Transport factory: wrap `createAgentTransport`'s stream to tee
  //    task-events into `emitEvent`. The wrapped stream still flows
  //    every chunk downstream so startRun's fan-out and persistence
  //    pipelines see the complete stream.
  //
  //    `createAgentTransport` returns a `ChatTransport<AgentUIMessage>`
  //    whose `sendMessages` accepts a richer args object than
  //    `RunTransport.sendMessages` does. We narrow it to `RunTransport`
  //    by type-asserting through `unknown` — the same shape coercion
  //    `bootstrap.ts:defaultBuildTransport` relies on for the renderer-
  //    initiated path.
  const buildTransport = (_a: StartRunArgs): RunTransport => ({
    async sendMessages(opts) {
      const settings = await storage.getSettings();
      const agentSettings = await storage.getAgentSettings();
      const transport = await createAgentTransport(
        settings,
        agentSettings.agentModel,
        args.spaceId,
        null,
        conversationId,
        undefined,
        // headless: { autoApprove: true, allowDelegate: true }.
        //
        // Consent rationale for MCP runs: by the time we reach this code
        // path the user has already (a) granted the host an OAuth token
        // for the `task` scope, AND (b) the per-host policy + global
        // `mcpAlwaysConfirmTasks` toggle + per-task confirmation prompt
        // (handled in mcp-bridge/confirmation.ts) have all said "yes,
        // this MCP host may run this task." Those gates ARE the user
        // consent for the run. Re-prompting per tool call would (1) be
        // unanswerable — MCP conversations are hidden from the user's
        // sidebar so there's no surface to render an approval prompt
        // on, and (2) cause the agent to silently stall and have its
        // call healed to `output-denied` via `heal-chatdb.ts`. That's
        // an "obey the system prompt's instruction to clean up tabs →
        // silently fail" footgun.
        //
        // With `autoApprove: true`:
        //   - The outer `needsApprovalWithHeadless` wrapper
        //     (agent-transport.ts:1281-1298) returns `false` for every
        //     approval-gated tool — closeTabs, executePython,
        //     executeOnPage, Write/Edit, Delete, install_skill,
        //     create_skill, updateMemory, deleteArtifact, proposePlan.
        //
        // With `allowDelegate: true`:
        //   - The tool-set filter (agent-transport.ts:2636-2681) keeps
        //     `delegate` available so the agent can fan out work to
        //     subagents. The drop is on by default for headless
        //     scheduled runs (they're single-purpose "do one thing"
        //     runs that shouldn't spawn expensive subagent trees), but
        //     MCP runs are full agent runs with the same capability
        //     surface as in-extension chats. Subagents spawned from
        //     an MCP run inherit the parent's `autoApprove: true` via
        //     the parent-scoped `headlessRunPolicies` lookup.
        //
        // Trade-off: the agent gains unsupervised access to destructive
        // tools (Delete, install_skill, create_skill, executePython with
        // allow_network). This is the correct posture for a remote API
        // surface that has already been consented to. The user does
        // retain coarser-grained controls over WHETHER the task runs
        // at all:
        //   - The host's policy (auto-allow / always-prompt / blocked)
        //     gates whether the task dispatches.
        //   - The global `mcpAlwaysConfirmTasks` toggle forces a
        //     per-task confirmation prompt regardless of policy.
        // Both gate the task at the DISPATCH layer, not at individual
        // tool invocations — once the run starts, autoApprove governs
        // tool-call behaviour. A user who wants per-tool oversight
        // should not use MCP at all; per-tool oversight requires the
        // attended in-extension chat surface.
        //
        // The HEADLESS_SYSTEM_PROMPT_PREFIX (agent-transport.ts)
        // additionally instructs the agent that it's running
        // unattended and to use destructive tools deliberately — so
        // the model itself participates in keeping behaviour
        // proportionate.
        { autoApprove: true, allowDelegate: true },
      );
      if (transport == null) {
        const err = new Error(
          `[mcp-task-runner] createAgentTransport returned null for model ${agentSettings.agentModel}`,
        );
        args.emitEvent({ kind: "error", message: err.message });
        throw err;
      }
      const runTransport = transport as unknown as RunTransport;
      const sourceStream = await runTransport.sendMessages(opts);
      return teeStreamForEvents(sourceStream, args.emitEvent, emitState);
    },
  });

  // 5. Default persister to chat-db.
  const buildPersister = (a: StartRunArgs) =>
    createAssistantStreamPersisterDefault(a.conversationId);

  // 6. No-op snapshot broadcaster. MCP tasks have no renderer-Port
  //    subscribers (the WS bridge consumes events via the chunk-tee
  //    above), so STREAM_PARTS / STREAM_DONE broadcasts would be
  //    purely speculative. The interface still requires `emit` + `done`.
  const buildSnapshotBroadcaster = (): SnapshotBroadcaster => ({
    emit: () => {},
    done: () => {},
  });

  // 7. Fire the run. `startRun` registers the handle synchronously
  //    and returns the control immediately; the actual stream
  //    processing happens in its internal IIFE.
  const control: RunControl = startRun(startArgs, {
    registry: agentHostRegistry,
    buildTransport,
    buildPersister,
    buildSnapshotBroadcaster,
  });

  // 8. Wire external abort → run abort. Once-only so a re-abort on
  //    the same signal is a no-op (the second `abort.abort()` call
  //    is itself idempotent, but the listener removal keeps GC clean).
  const onExternalAbort = () => {
    try {
      control.handle.abort.abort();
    } catch {
      // Best-effort; the run may already have terminated.
    }
  };
  if (args.abortSignal.aborted) {
    onExternalAbort();
  } else {
    args.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    conversationId,
    completion: control.completion,
    handle: control.handle,
  };
}
