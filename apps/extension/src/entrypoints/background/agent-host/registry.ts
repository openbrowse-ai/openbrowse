/**
 * Service-worker-side registry of in-flight agent runs.
 *
 * One `RunHandle` per `conversationId` while a run is live. The SW is the
 * single deterministic host for every run; this registry is therefore also
 * the single source of truth for "is there an active run?". It replaces
 * the per-renderer `runOwnership` IDB lock for the live host-claim purpose
 * (the IDB-based serializer can still arbitrate concurrent `startRun`
 * calls inside the SW itself; see `run.ts`).
 *
 * Subscribers are the set of long-lived `chrome.runtime.Port`s opened by
 * renderer surfaces (sidepanel/home/newtab/popup) that want to receive
 * the chunk fan-out for this conversation. A run continues independently
 * of how many subscribers are attached: when the last port disconnects,
 * the run keeps streaming and persisting; new subscribers may rejoin at
 * any time and receive a snapshot of the current state plus live chunks.
 */

export type RunStatus = "running" | "completed" | "errored" | "aborted";

export interface RunHandle {
  conversationId: string;
  abort: AbortController;
  startedAt: number;
  status: RunStatus;
  subscribers: Set<chrome.runtime.Port>;
}

export interface AgentHostRegistry {
  register(handle: RunHandle): void;
  get(conversationId: string): RunHandle | undefined;
  release(conversationId: string): void;
  list(): RunHandle[];
}

export function createRegistry(): AgentHostRegistry {
  const handles = new Map<string, RunHandle>();

  return {
    register(handle: RunHandle): void {
      if (handles.has(handle.conversationId)) {
        throw new Error(
          `[agent-host/registry] conversationId ${handle.conversationId} is already registered`,
        );
      }
      handles.set(handle.conversationId, handle);
    },

    get(conversationId: string): RunHandle | undefined {
      return handles.get(conversationId);
    },

    release(conversationId: string): void {
      handles.delete(conversationId);
    },

    list(): RunHandle[] {
      return Array.from(handles.values());
    },
  };
}

/**
 * Process-singleton registry for the running SW. Module-scope so every
 * file inside the agent-host package shares the same map. Tests use
 * `createRegistry()` directly for isolation.
 */
export const agentHostRegistry: AgentHostRegistry = createRegistry();
