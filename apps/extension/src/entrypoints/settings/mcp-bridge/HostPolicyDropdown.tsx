import { useCallback, useState } from "react";
import type { HostPolicy } from "@/lib/mcp-host-policy";

export interface HostPolicyDropdownProps {
  clientId: string;
  value: HostPolicy;
  onChanged: (next: HostPolicy) => void;
  disabled?: boolean;
}

/**
 * The three policy values the dropdown offers, in display order.
 *
 * Labels rewritten for non-technical users on 2026-06-29:
 *   - `auto-allow`     → "Trust automatically" (default after OAuth)
 *   - `always-prompt`  → "Ask every time"
 *   - `blocked`        → "Blocked"
 *
 * `auto-allow` is the default for newly-OAuthed hosts, so it's listed
 * first to match the most common state.
 */
export const POLICY_OPTIONS: ReadonlyArray<{
  value: HostPolicy;
  label: string;
}> = [
  { value: "auto-allow", label: "Trust automatically" },
  { value: "always-prompt", label: "Ask every time" },
  { value: "blocked", label: "Blocked" },
] as const;

/**
 * Pure helper, exported for unit testing: shapes the
 * `MCP_BRIDGE_SET_POLICY` message.
 */
export function buildSetPolicyMessage(
  clientId: string,
  policy: HostPolicy,
): { type: "MCP_BRIDGE_SET_POLICY"; clientId: string; policy: HostPolicy } {
  return { type: "MCP_BRIDGE_SET_POLICY", clientId, policy };
}

/**
 * Pure helper, exported for unit testing: one-sentence explanation
 * of what the currently-selected policy does. Surfaced below the
 * dropdown so users understand the consequence of their choice.
 */
export function policyDescription(p: HostPolicy): string {
  switch (p) {
    case "auto-allow":
      return "Actions run without asking you first.";
    case "always-prompt":
      return "Every action requires your approval before it runs.";
    case "blocked":
      return "This MCP client cannot do anything in your browser.";
  }
}

export function HostPolicyDropdown({
  clientId,
  value,
  onChanged,
  disabled,
}: HostPolicyDropdownProps) {
  const [busy, setBusy] = useState(false);

  const handleChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value as HostPolicy;
      if (next === value || busy) return;
      setBusy(true);
      try {
        await chrome.runtime.sendMessage(buildSetPolicyMessage(clientId, next));
        onChanged(next);
      } finally {
        setBusy(false);
      }
    },
    [busy, clientId, onChanged, value],
  );

  return (
    <div className="flex flex-col gap-1">
      <select
        value={value}
        onChange={handleChange}
        disabled={disabled || busy}
        className="rounded border border-border bg-background px-2 py-1 text-xs"
        aria-label="Confirmation policy"
      >
        {POLICY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <div className="text-[11px] leading-tight text-muted-foreground">
        {policyDescription(value)}
      </div>
    </div>
  );
}
