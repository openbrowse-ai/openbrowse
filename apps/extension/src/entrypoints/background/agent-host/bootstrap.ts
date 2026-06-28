/**
 * Service-worker agent host bootstrap.
 *
 * Wires the registry, port router, and `startRun`/`stopRun` together
 * with a production `buildTransport` that constructs the same
 * `CompactingChatTransport` the renderer used to build in
 * `useAgentChat.ts:852`.
 *
 * Settings come from two sources:
 *   - **Global settings** (provider configs, downloaded models, MCP
 *     servers, etc.) are read straight from `chrome.storage` via
 *     `storage.getSettings()`. The SW has access to storage, and the
 *     freshest value at run-start time is what we want.
 *   - **Per-conversation agent settings** (`agentModel`,
 *     `thinkingEnabled`, `thinkingConfig`) are sent over the wire from
 *     the renderer in the `AGENT_RUN_START` payload's `settingsSnapshot`.
 *     The renderer is the source of truth for which conversation has
 *     which active model.
 *
 * The bootstrap is idempotent: re-running `installAgentHost` is a no-op
 * after the first call.
 */

import { storage } from "@/lib/storage";
import {
  createAgentTransport,
  setAgentContext,
} from "@/lib/agent/agent-transport";
import type { Settings, ThinkingConfig } from "@/lib/types";
import { createAssistantStreamPersisterDefault } from "./persist-stream";
import { createPortRouter } from "./port-router";
import {
  AGENT_RUN,
  type AgentRunStartPayload,
} from "./messages";
import { agentHostRegistry } from "./registry";
import {
  startRun as startRunImpl,
  stopRun as stopRunImpl,
  type RunControl,
  type RunTransport,
} from "./run";
import { createSnapshotBroadcaster } from "./snapshot-broadcast";

/**
 * Per-conversation settings the renderer is responsible for passing to
 * the SW. Anything global (provider configs, MCP servers) is read by
 * the SW from `storage`.
 */
export interface AgentRunSettingsSnapshot {
  agentModel: string;
  spaceId: string | null;
  thinkingEnabled?: boolean;
  thinkingConfig?: ThinkingConfig;
  headless?: { autoApprove: boolean };
}

export function isAgentRunSettingsSnapshot(
  x: unknown,
): x is AgentRunSettingsSnapshot {
  // Validate the full shape so a malformed `settingsSnapshot` is
  // rejected at the Port boundary rather than crashing later in
  // `createAgentTransport`. Required: `agentModel: string`, `spaceId:
  // string | null`. Optional: `thinkingEnabled: boolean`,
  // `thinkingConfig: object`, `headless: { autoApprove: boolean }`.
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.agentModel !== "string") return false;
  // `spaceId` must be present and either string or null.
  if (!("spaceId" in o)) return false;
  if (o.spaceId !== null && typeof o.spaceId !== "string") return false;
  // Optional fields, if present, must have the right type.
  if (
    "thinkingEnabled" in o &&
    o.thinkingEnabled !== undefined &&
    typeof o.thinkingEnabled !== "boolean"
  ) {
    return false;
  }
  if (
    "thinkingConfig" in o &&
    o.thinkingConfig !== undefined &&
    (typeof o.thinkingConfig !== "object" || o.thinkingConfig === null)
  ) {
    return false;
  }
  if ("headless" in o && o.headless !== undefined) {
    if (typeof o.headless !== "object" || o.headless === null) return false;
    const headless = o.headless as Record<string, unknown>;
    if (typeof headless.autoApprove !== "boolean") return false;
  }
  return true;
}

async function resolveSpaceName(
  spaceId: string | null,
): Promise<string | null> {
  if (spaceId == null) return null;
  try {
    const spaces = await storage.getSpaces();
    return spaces.find((s) => s.id === spaceId)?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Production transport builder. Returns a `RunTransport` that calls
 * through to `createAgentTransport` (the same factory the renderer
 * historically used). The returned transport's `sendMessages` honours
 * the abort signal and yields a `ReadableStream<UIMessageChunk>` per
 * `CompactingChatTransport`'s contract.
 */
async function defaultBuildTransport(
  conversationId: string,
  snapshot: AgentRunSettingsSnapshot,
): Promise<RunTransport> {
  const settings: Settings = await storage.getSettings();
  const spaceName = await resolveSpaceName(snapshot.spaceId);
  // Pin the SW-realm module-scope `agentConversationId` before building the
  // transport. The agent loop reads it in many places (handle hydration,
  // tool wrappers) and the renderer used to call this from useAgentChat.
  // Under SW-host the renderer-realm call is a no-op for the SW; we must
  // set it here so the SW's loop sees the correct cid.
  setAgentContext(conversationId);

  // Eagerly resolve the conversation's working window so the synchronous
  // `session.targetWindowId` reads (in `buildExtensionToolContext`,
  // `listTabs` tool dispatch, awareness-block builder) see the right
  // value from the very first tool call. Without this, the first call
  // would fall back to `chrome.windows.getCurrent()` and might bind a
  // foreign-window tab. The resolver walks owned-tab → originWindowId
  // → space window. Failures are non-fatal: an unset cache entry just
  // means callers async-resolve lazily.
  try {
    const { resolveConversationWindowId } = await import(
      "@/lib/agent/conversation-window"
    );
    const { setAgentWindow } = await import("@/lib/agent/agent-transport");
    const windowId = await resolveConversationWindowId(conversationId);
    setAgentWindow(conversationId, windowId ?? null);
  } catch {
    // Best-effort; lazy resolver on next tool call covers the failure.
  }

  const transport = await createAgentTransport(
    settings,
    snapshot.agentModel,
    snapshot.spaceId,
    spaceName,
    conversationId,
    snapshot.thinkingEnabled
      ? { enabled: true, config: snapshot.thinkingConfig }
      : undefined,
    snapshot.headless,
  );
  if (transport == null) {
    throw new Error(
      `[agent-host/bootstrap] createAgentTransport returned null for model ${snapshot.agentModel}`,
    );
  }
  return transport;
}

/**
 * Start a run from a validated AGENT_RUN_START payload. The router has
 * already confirmed the message shape and that no run currently exists
 * for this conversationId.
 */
function startRunFromPayload(payload: AgentRunStartPayload): RunControl {
  if (!isAgentRunSettingsSnapshot(payload.settingsSnapshot)) {
    throw new Error(
      "[agent-host/bootstrap] AGENT_RUN_START missing settingsSnapshot",
    );
  }
  const snapshot = payload.settingsSnapshot;
  return startRunImpl(
    {
      conversationId: payload.conversationId,
      messages: payload.messages,
      origin: payload.origin,
    },
    {
      registry: agentHostRegistry,
      buildTransport: () => ({
        async sendMessages(opts) {
          const t = await defaultBuildTransport(
            payload.conversationId,
            snapshot,
          );
          return t.sendMessages(opts);
        },
      }),
      buildPersister: (a) =>
        createAssistantStreamPersisterDefault(a.conversationId),
      buildSnapshotBroadcaster: (a) =>
        createSnapshotBroadcaster(a.conversationId),
    },
  );
}

let installed = false;

/**
 * Register the agent-host onConnect listener. Idempotent; subsequent
 * calls are no-ops. Intended to be called once during SW startup.
 */
export function installAgentHost(): void {
  if (installed) return;
  installed = true;

  const router = createPortRouter({
    registry: agentHostRegistry,
    startRun: (payload) => {
      try {
        return startRunFromPayload(payload);
      } catch (err) {
        // If we cannot start, emit AGENT_RUN_ERROR-style telemetry to
        // anyone listening (the renderer surface that just sent the
        // START) by registering a bogus handle, posting the error, then
        // releasing. Cleaner: bubble back to the router caller.
        const message = err instanceof Error ? err.message : String(err);
        const failHandle = {
          conversationId: payload.conversationId,
          abort: new AbortController(),
          startedAt: Date.now(),
          status: "errored" as const,
          subscribers: new Set<chrome.runtime.Port>(),
        };
        // Don't register — failure path. Return a synthetic RunControl
        // whose completion has already rejected. The router will still
        // try to add the port to subscribers, which is harmless because
        // the handle is never registered.
        return {
          handle: failHandle,
          completion: Promise.resolve().then(() => {
            // Subscribers (whoever the router adds) should receive the
            // error so the renderer can surface it.
            for (const port of failHandle.subscribers) {
              try {
                port.postMessage({
                  type: AGENT_RUN.ERROR,
                  conversationId: payload.conversationId,
                  message,
                });
              } catch {}
            }
          }),
        };
      }
    },
    stopRun: (reg, conversationId) => stopRunImpl(reg, conversationId),
  });

  chrome.runtime.onConnect.addListener((port) => {
    router.handleConnect(port);
  });
}
