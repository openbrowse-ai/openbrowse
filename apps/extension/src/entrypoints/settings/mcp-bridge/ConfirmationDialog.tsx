import { useCallback, useEffect, useState } from "react";

export interface PendingPromptSummary {
  promptId: string;
  clientId: string;
  hostName: string;
  prompt: string;
  targetWindowInfo: { windowId: number; activeTabUrl?: string; spaceName?: string };
  createdAt: number;
}

export interface ConfirmationDialogProps {
  prompt: PendingPromptSummary;
  onResolved: (outcome: "allow" | "deny") => void;
  /**
   * Auto-deny deadline (epoch ms) for the countdown caption. When
   * undefined or non-positive the caption is omitted (matches the
   * user's "Never" auto-deny setting).
   *
   * Defaulted by the parent (`ActivitySection`) from
   * `Settings.mcpAutoDenyMs`, falling back to 60s — the historical
   * `AUTO_DENY_MS`. The SW is authoritative for the actual timeout;
   * this prop drives display only.
   */
  autoDenyAt?: number | null;
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * Pure helper, exported for unit testing: builds the message payload
 * sent to the background for a confirmation outcome.
 */
export function buildConfirmMessage(
  promptId: string,
  outcome: "allow" | "deny",
): { type: "MCP_BRIDGE_CONFIRM_TASK"; promptId: string; outcome: "allow" | "deny" } {
  return { type: "MCP_BRIDGE_CONFIRM_TASK", promptId, outcome };
}

/**
 * Pure helper, exported for unit testing: builds the "always trust"
 * payload that upgrades a host's policy to `auto-allow` AND approves
 * the current prompt in a single user gesture.
 *
 * Two messages get sent: `MCP_BRIDGE_SET_POLICY` followed by
 * `MCP_BRIDGE_CONFIRM_TASK` with `outcome: "allow"`. We expose the
 * builders so tests can assert exact shape without rendering.
 */
export function buildAlwaysAllowMessages(
  clientId: string,
  promptId: string,
): {
  setPolicy: { type: "MCP_BRIDGE_SET_POLICY"; clientId: string; policy: "auto-allow" };
  confirm: { type: "MCP_BRIDGE_CONFIRM_TASK"; promptId: string; outcome: "allow" };
} {
  return {
    setPolicy: { type: "MCP_BRIDGE_SET_POLICY", clientId, policy: "auto-allow" },
    confirm: { type: "MCP_BRIDGE_CONFIRM_TASK", promptId, outcome: "allow" },
  };
}

/**
 * Pure helper, exported for unit testing: build the "where will this
 * run" caption. We avoid surfacing the raw chrome window id (a
 * meaningless integer to most users) by treating it as opaque; the
 * caption shows the space name and active URL when known, falling
 * back to "in a browser window" when neither is available.
 */
export function formatTargetCaption(
  info: PendingPromptSummary["targetWindowInfo"],
): string {
  if (info.spaceName) {
    return info.activeTabUrl
      ? `In your ${info.spaceName} space · ${info.activeTabUrl}`
      : `In your ${info.spaceName} space`;
  }
  if (info.activeTabUrl) return `In a browser window · ${info.activeTabUrl}`;
  return "In a browser window";
}

/**
 * Pure helper, exported for unit testing: format the auto-deny
 * countdown as a short caption ("Auto-cancels in 47s") or null when
 * the deadline has passed / is unset.
 */
export function formatAutoDenyCaption(
  deadline: number | null | undefined,
  now: number,
): string | null {
  if (deadline == null || deadline <= 0) return null;
  const remainingMs = deadline - now;
  if (remainingMs <= 0) return null;
  const remainingSec = Math.ceil(remainingMs / 1000);
  return `Auto-cancels in ${remainingSec}s`;
}

export function ConfirmationDialog({
  prompt,
  onResolved,
  autoDenyAt,
  now = Date.now,
}: ConfirmationDialogProps) {
  const [busy, setBusy] = useState(false);

  // Force a re-render every second while the countdown is active so
  // the caption stays current. The interval is cheap and the render
  // is small; we don't bother throttling further.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (autoDenyAt == null || autoDenyAt <= 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [autoDenyAt]);

  const handle = useCallback(
    async (outcome: "allow" | "deny") => {
      if (busy) return;
      setBusy(true);
      try {
        await chrome.runtime.sendMessage(buildConfirmMessage(prompt.promptId, outcome));
        onResolved(outcome);
      } finally {
        setBusy(false);
      }
    },
    [busy, prompt.promptId, onResolved],
  );

  const handleAlwaysAllow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const msgs = buildAlwaysAllowMessages(prompt.clientId, prompt.promptId);
      await chrome.runtime.sendMessage(msgs.setPolicy);
      await chrome.runtime.sendMessage(msgs.confirm);
      onResolved("allow");
    } finally {
      setBusy(false);
    }
  }, [busy, prompt.clientId, prompt.promptId, onResolved]);

  const countdown = formatAutoDenyCaption(autoDenyAt, now());

  return (
    <div className="rounded-lg border border-amber-500/60 bg-amber-50/40 p-4 dark:border-amber-500/40 dark:bg-amber-950/20">
      <div className="text-sm font-medium">
        {prompt.hostName} wants to run a task
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
        {prompt.prompt}
      </p>
      <div className="mt-2 text-xs text-muted-foreground">
        {formatTargetCaption(prompt.targetWindowInfo)}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          onClick={() => handle("allow")}
        >
          Allow
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded border border-emerald-600 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-600 dark:text-emerald-300 dark:hover:bg-emerald-950"
          onClick={handleAlwaysAllow}
        >
          Always allow {prompt.hostName}
        </button>
        <button
          type="button"
          disabled={busy}
          className="rounded border px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50"
          onClick={() => handle("deny")}
        >
          Deny
        </button>
      </div>
      {countdown && (
        <div className="mt-2 text-xs text-muted-foreground">{countdown}</div>
      )}
    </div>
  );
}
