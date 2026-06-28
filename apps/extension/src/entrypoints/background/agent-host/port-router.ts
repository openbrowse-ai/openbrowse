/**
 * Service-worker connection router for the agent-run protocol.
 *
 * Listens for incoming `chrome.runtime.connect` ports whose name starts
 * with `agent-run:` and dispatches their messages against the agent
 * host.
 *
 * Lifecycle of a port:
 *
 *   1. Renderer opens `chrome.runtime.connect({ name: "agent-run:<id>" })`.
 *   2. SW `chrome.runtime.onConnect` fires → router's `handleConnect`.
 *   3. Router sends `AGENT_RUN_ACK` reporting whether a run is already
 *      live. If a run exists, the port is added immediately to
 *      `handle.subscribers` and starts receiving live chunks.
 *   4. Router subscribes to `port.onMessage` and `port.onDisconnect`.
 *   5. On `AGENT_RUN_START`: invoke the injected `startRun`, passing
 *      the validated payload. The router does NOT interpret the
 *      `settingsSnapshot` field — it forwards the entire payload so
 *      callers can carry through host-specific metadata. Then add the
 *      port to the new handle's subscribers. Subsequent
 *      `AGENT_RUN_START`s on the same port (after the prior run
 *      terminates) start fresh runs — matches the AI SDK's "approval →
 *      auto-resume → new sendMessages call" pattern.
 *   6. On `AGENT_RUN_STOP`: invoke the injected `stopRun`.
 *   7. On `port.onDisconnect`: remove from `handle.subscribers`. The run
 *      continues independently; this is the parallelism property the
 *      whole SW-host migration exists to provide.
 *
 * The router intentionally does **not** route `AGENT_RUN_APPROVE`
 * messages over the port. Approval state lives in the renderer-side
 * `Chat` instance (the AI SDK's `addToolApprovalResponse` mutates the
 * UIMessage list). When the user approves, `sendAutomaticallyWhen`
 * (`useAgentChat.ts:462`) triggers a new `sendMessage`, which posts a
 * fresh `AGENT_RUN_START` here.
 */

import { parseAgentRunPortName } from "./messages";
import {
  AGENT_RUN,
  isAgentRunStartPayload,
  isAgentRunStopPayload,
  type AgentRunAckPayload,
  type AgentRunStartPayload,
} from "./messages";
import type { AgentHostRegistry } from "./registry";
import type { RunControl } from "./run";

export interface PortRouterDeps {
  registry: AgentHostRegistry;
  /**
   * Invoked when a port sends a well-formed `AGENT_RUN_START`. Receives
   * the *full* payload (including any host-specific metadata like
   * `settingsSnapshot`) so the implementer can carry that through to
   * `startRunImpl`.
   */
  startRun: (payload: AgentRunStartPayload) => RunControl;
  stopRun: (registry: AgentHostRegistry, conversationId: string) => void;
}

export interface PortRouter {
  /** Invoke for every incoming `chrome.runtime.onConnect`. */
  handleConnect(port: chrome.runtime.Port): void;
}

export function createPortRouter(deps: PortRouterDeps): PortRouter {
  return {
    handleConnect(port: chrome.runtime.Port): void {
      const conversationId = parseAgentRunPortName(port.name);
      if (conversationId == null) {
        // Foreign port (e.g. "sidepanel", "settings"). Leave untouched.
        return;
      }

      const existing = deps.registry.get(conversationId);
      // A handle in the registry may be in a terminal state (`completed`/
      // `aborted`/`errored`) when its run's `finally` block is mid-flight
      // — `emitDone`/`emitError` has fired and `handle.status` has been
      // updated, but `registry.release` hasn't been called yet because
      // the finally block is still running async cleanup (chatDb heal +
      // snapshot.done broadcast). During that window, a new probe that
      // attaches as a subscriber would never receive a terminal event
      // (it was already emitted to the prior subscriber set) and would
      // mistakenly believe the run is still active. So the ACK must
      // reflect the run's STATUS, not just the handle's registration.
      const hasActiveRun = existing != null && existing.status === "running";
      const ack: AgentRunAckPayload = {
        type: AGENT_RUN.ACK,
        conversationId,
        hasActiveRun,
      };
      try {
        port.postMessage(ack);
      } catch {
        // Port already disconnected before we could ACK. Bail.
        return;
      }

      // If a run is already live (still running), join its fan-out.
      // Don't attach to a terminal-status handle — there's nothing more
      // to fan out, and attaching would just leak a subscriber slot
      // until the handle is released.
      if (existing != null && existing.status === "running") {
        existing.subscribers.add(port);
      }

      port.onMessage.addListener((msg: unknown) => {
        if (isAgentRunStartPayload(msg)) {
          // Port name binds the conversationId — refuse mismatched START.
          if (msg.conversationId !== conversationId) return;
          // If a run is currently RUNNING for this conversation, fold
          // this duplicate START into a viewer attach (see the existing
          // comment below). But if the existing handle is in a terminal
          // state (mid-cleanup, not yet released), treat this START as
          // a fresh request — the prior run is effectively over.
          const live = deps.registry.get(conversationId);
          if (live != null) {
            if (live.status === "running") {
              live.subscribers.add(port);
              return;
            } else {
              // The prior run is in a terminal state but its `finally`
              // block hasn't called `registry.release` yet. We must
              // evict it explicitly so `startRun` doesn't throw a
              // "conversation already registered" error.
              deps.registry.release(conversationId);
            }
          }
          // `deps.startRun` is permitted to throw synchronously (e.g.
          // if a future invariant in `registry.register` rejects a
          // re-register that wasn't evicted). Without catching, the
          // throw would propagate out of this `onMessage` callback into
          // the Chrome runtime dispatcher — the ACK has already been
          // posted, so the renderer would wait forever for chunks that
          // never come. Surface the failure as `AGENT_RUN_ERROR` on the
          // same port and disconnect so the renderer's reader resolves.
          let control: RunControl;
          try {
            control = deps.startRun(msg);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            try {
              port.postMessage({
                type: AGENT_RUN.ERROR,
                conversationId,
                message,
              });
            } catch {
              // Port already dead; nothing left to do.
            }
            try {
              port.disconnect();
            } catch {
              // ignore
            }
            return;
          }
          control.handle.subscribers.add(port);
          return;
        }

        if (isAgentRunStopPayload(msg)) {
          if (msg.conversationId !== conversationId) return;
          deps.stopRun(deps.registry, conversationId);
          return;
        }

        // Other message types (APPROVE, REGEN) are reserved for future
        // wiring. Silently drop unrecognized payloads — defence-in-depth
        // against malformed third-party messages.
      });

      port.onDisconnect.addListener(() => {
        const handle = deps.registry.get(conversationId);
        if (handle != null) {
          handle.subscribers.delete(port);
        }
      });
    },
  };
}
