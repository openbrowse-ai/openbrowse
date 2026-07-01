import { useCallback, useEffect, useState } from "react";
import type { HostPolicy } from "@/lib/mcp-host-policy";
import { HostPolicyDropdown } from "./HostPolicyDropdown";
import {
  formatLastSeen,
  type HostSummary,
} from "./host-summary";

/**
 * Pure helper, exported for unit testing: shapes the
 * `MCP_BRIDGE_LIST_HOSTS` request message. Keeping it as a pure builder
 * makes the message type discoverable without scanning JSX.
 */
export function buildListHostsMessage(): { type: "MCP_BRIDGE_LIST_HOSTS" } {
  return { type: "MCP_BRIDGE_LIST_HOSTS" };
}

/**
 * Pure helper, exported for unit testing: shapes the
 * `MCP_BRIDGE_REVOKE_HOST` request message.
 */
export function buildRevokeMessage(
  clientId: string,
): { type: "MCP_BRIDGE_REVOKE_HOST"; clientId: string } {
  return { type: "MCP_BRIDGE_REVOKE_HOST", clientId };
}

interface ListHostsResponse {
  ok: boolean;
  hosts?: HostSummary[];
  error?: string;
}

export interface HostsListProps {
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
}

export function HostsList({ now = Date.now }: HostsListProps = {}) {
  const [hosts, setHosts] = useState<HostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const resp = (await chrome.runtime.sendMessage(
        buildListHostsMessage(),
      )) as ListHostsResponse;
      if (!resp?.ok) {
        setError(resp?.error ?? "Failed to load hosts");
        return;
      }
      setError(null);
      // Newest-seen first; ties broken by clientId for stable order.
      setHosts(
        (resp.hosts ?? []).slice().sort((a, b) => {
          if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
          return a.clientId.localeCompare(b.clientId);
        }),
      );
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handlePolicyChanged = useCallback(
    (clientId: string, next: HostPolicy) => {
      setHosts((prev) =>
        prev?.map((h) =>
          h.clientId === clientId ? { ...h, policy: next } : h,
        ) ?? prev,
      );
    },
    [],
  );

  const handleBlock = useCallback(
    async (clientId: string) => {
      await chrome.runtime.sendMessage(buildRevokeMessage(clientId));
      // Reflect locally; the background side has flipped the policy to
      // "blocked", which is what we display.
      handlePolicyChanged(clientId, "blocked");
    },
    [handlePolicyChanged],
  );

  if (error) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        Couldn't load connected MCP clients: {error}
      </div>
    );
  }

  if (hosts === null) {
    return (
      <div className="text-sm text-muted-foreground">Loading…</div>
    );
  }

  if (hosts.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No MCP clients have connected yet. AI tools like Cursor, Claude
        Desktop, or OpenCode can connect to OpenBrowse to take actions in
        your browser.
      </div>
    );
  }

  const nowMs = now();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
            <th className="py-2 pr-3 font-medium">MCP client</th>
            <th className="py-2 pr-3 font-medium">Actions</th>
            <th className="py-2 pr-3 font-medium">Last used</th>
            <th className="py-2 pr-3 font-medium">Confirmation</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => (
            <tr
              key={h.clientId}
              className="border-b border-border/50 last:border-b-0"
            >
              <td className="py-2 pr-3">
                <div className="font-medium">{h.clientName}</div>
              </td>
              <td className="py-2 pr-3 tabular-nums">{h.callCount}</td>
              <td className="py-2 pr-3 text-muted-foreground">
                {formatLastSeen(h.lastSeenAt, nowMs)}
              </td>
              <td className="py-2 pr-3">
                <HostPolicyDropdown
                  clientId={h.clientId}
                  value={h.policy}
                  onChanged={(next) => handlePolicyChanged(h.clientId, next)}
                />
              </td>
              <td className="py-2">
                <button
                  type="button"
                  disabled={h.policy === "blocked"}
                  onClick={() => void handleBlock(h.clientId)}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  title={
                    h.policy === "blocked"
                      ? "Already blocked"
                      : `Block ${h.clientName}`
                  }
                >
                  {h.policy === "blocked" ? "Blocked" : "Block"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
