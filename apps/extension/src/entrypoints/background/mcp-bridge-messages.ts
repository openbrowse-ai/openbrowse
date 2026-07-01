import { bootMcpBridge, getStatus, acceptTofu, declineTofu, clearTrustAndReconnect, forceReconnectNow } from "./mcp-bridge/boot";

type SendResponse = (response: unknown) => void;

export async function handleMcpBridgeMessage(
  message: { type: string; [k: string]: unknown },
  sendResponse: SendResponse,
): Promise<void> {
  try {
    switch (message.type) {
      case "MCP_BRIDGE_GET_STATUS": {
        // Returns the full discriminated-union `BridgeStatus`. The
        // long-lived port (`mcp-bridge:status`) is the primary surface;
        // this one-shot message is kept as a back-compat / probe API.
        sendResponse({ ok: true, status: getStatus() });
        return;
      }
      case "MCP_BRIDGE_BOOT": {
        await bootMcpBridge((message.url as string | undefined) ?? undefined);
        sendResponse({ ok: true });
        return;
      }
      case "MCP_BRIDGE_ACCEPT_TOFU": {
        await acceptTofu();
        sendResponse({ ok: true });
        return;
      }
      case "MCP_BRIDGE_DECLINE_TOFU": {
        declineTofu();
        sendResponse({ ok: true });
        return;
      }
      case "MCP_BRIDGE_CLEAR_TRUST": {
        // Idempotent: clears the stored fingerprint and forces an
        // immediate reconnect. Used by the key-mismatch recovery flow
        // after the user has verified out-of-band that the broker key
        // was legitimately rotated.
        await clearTrustAndReconnect();
        sendResponse({ ok: true });
        return;
      }
      case "MCP_BRIDGE_FORCE_RECONNECT": {
        // Used by the "Reconnect now" button in the settings panel.
        // Cancels any pending backoff timer and attempts a fresh
        // connection synchronously.
        await forceReconnectNow();
        sendResponse({ ok: true });
        return;
      }
      case "MCP_BRIDGE_LIST_ACTIVE_TASKS": {
        // Map the in-memory ActiveTask rows to a serializable summary —
        // the raw rows hold a non-cloneable AbortController and a
        // clientId that the UI has no business knowing about.
        const { tasksStore } = await import("./tasks-store");
        const tasks = tasksStore.list().map((t) => ({
          taskId: t.taskId,
          hostName: t.hostName,
          prompt: t.prompt,
          targetWindowId: t.targetWindowId,
          spaceId: t.spaceId ?? null,
          startedAt: t.startedAt,
          taskTitlePreview: t.taskTitlePreview ?? null,
        }));
        sendResponse({ ok: true, tasks });
        return;
      }
      case "MCP_BRIDGE_LIST_PENDING_PROMPTS": {
        const { listPendingPrompts } = await import("./mcp-bridge/confirmation");
        sendResponse({ ok: true, prompts: listPendingPrompts() });
        return;
      }
      case "MCP_BRIDGE_CONFIRM_TASK": {
        const { confirmPrompt } = await import("./mcp-bridge/confirmation");
        const promptId = message.promptId as string;
        const outcome = message.outcome as "allow" | "deny";
        const ok = confirmPrompt(promptId, outcome);
        sendResponse({ ok });
        return;
      }
      case "MCP_BRIDGE_CANCEL_TASK": {
        const { tasksStore } = await import("./tasks-store");
        const taskId = message.taskId as string;
        const cancelled = tasksStore.cancel(taskId);
        sendResponse({ ok: cancelled });
        return;
      }
      case "MCP_BRIDGE_LIST_HOSTS": {
        const { auditDb } = await import("@/lib/mcp-bridge-audit-db");
        const { listPolicies } = await import("@/lib/mcp-host-policy");
        const { summarizeHosts } = await import(
          "@/entrypoints/settings/mcp-bridge/host-summary"
        );
        const audit = await auditDb.list({ limit: 5000 });
        const policies = await listPolicies();
        sendResponse({ ok: true, hosts: summarizeHosts(audit, policies) });
        return;
      }
      case "MCP_BRIDGE_LIST_AUDIT": {
        // Phase 3 / Task 8: audit log viewer in the settings page. The
        // background side does the IDB read so the settings entrypoint
        // doesn't ship the idb client.
        const { auditDb } = await import("@/lib/mcp-bridge-audit-db");
        const limit = (message.limit as number | undefined) ?? 100;
        const clientId = message.clientId as string | undefined;
        const entries = await auditDb.list({ clientId, limit });
        sendResponse({ ok: true, entries });
        return;
      }
      case "MCP_BRIDGE_REVOKE_HOST": {
        // Phase 3 / Task 7: revocation = setting the local policy to "blocked".
        // Phase 3 / Task 11: additionally tell the broker to invalidate any
        // refresh tokens held by this client so the host can't silently
        // resume access after a session reconnect — it must go through a
        // fresh user-consented authorization_code flow.
        const { setPolicy } = await import("@/lib/mcp-host-policy");
        const clientId = message.clientId as string;
        await setPolicy(clientId, "blocked");
        try {
          const { getCurrentWs } = await import("./mcp-bridge/boot");
          const ws = getCurrentWs();
          // ws.OPEN === 1 — we accept the WS regardless of readyState here
          // because `send` on a CONNECTING ws will throw; we let the catch
          // swallow it. Local block is the primary defense; broker
          // invalidation is best-effort.
          if (ws) {
            ws.send(JSON.stringify({ type: "revoke-host", clientId }));
          }
        } catch {
          // Non-fatal: local block already revoked the policy.
        }
        sendResponse({ ok: true });
        return;
      }
      case "MCP_BRIDGE_SET_POLICY": {
        const { setPolicy } = await import("@/lib/mcp-host-policy");
        await setPolicy(
          message.clientId as string,
          message.policy as "always-prompt" | "auto-allow" | "blocked",
        );
        sendResponse({ ok: true });
        return;
      }
      case "MCP_BRIDGE_CONSENT_DECISION": {
        const { handleConsentDecision } = await import("./mcp-bridge/consent");
        const { getCurrentWs } = await import("./mcp-bridge/boot");
        const ws = getCurrentWs();
        const result = await handleConsentDecision({
          decision: message.decision as "allow" | "deny",
          state: message.state as string,
          redirectUrlWithCode: message.redirectUrlWithCode as string,
          ws,
        });
        sendResponse(result);
        return;
      }
      default:
        sendResponse({ ok: false, error: `unknown MCP_BRIDGE message: ${message.type}` });
    }
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
}
