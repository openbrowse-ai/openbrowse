import { useCallback, useEffect, useState } from "react";
import { storage } from "@/lib/storage";

/**
 * Preferences select: how long a pending confirmation prompt waits
 * before auto-denying. Mirrors `Settings.mcpAutoDenyMs`. Value `0`
 * means "Never auto-deny" — the prompt waits indefinitely for the
 * user.
 *
 * The actual auto-deny timer lives in
 * `mcp-bridge/confirmation.ts:awaitConfirmation`, which reads the
 * setting at prompt-registration time. Changing the value here does
 * NOT shorten or extend an already-pending prompt — by design, so
 * tightening the timeout can't retroactively auto-deny work the
 * user was about to approve.
 */
export const AUTO_DENY_OPTIONS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 30_000, label: "30 seconds" },
  { value: 60_000, label: "1 minute" },
  { value: 120_000, label: "2 minutes" },
  { value: 300_000, label: "5 minutes" },
  { value: 0, label: "Never" },
] as const;

/** Pure helper, exported for unit testing. */
export function resolveSelectedValue(stored: number | undefined): number {
  if (stored === undefined) return 60_000; // default
  return stored;
}

export function AutoDenyTimeoutSelect() {
  const [value, setValue] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await storage.getSettings();
      setValue(resolveSelectedValue(s.mcpAutoDenyMs));
    })();
  }, []);

  const onChange = useCallback(async (next: number) => {
    setValue(next);
    await storage.updateSettings((s) => ({ ...s, mcpAutoDenyMs: next }));
  }, []);

  if (value === null) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor="mcp-auto-deny-select"
        className="text-sm"
      >
        Auto-cancel timeout
      </label>
      <select
        id="mcp-auto-deny-select"
        value={String(value)}
        onChange={(e) => void onChange(Number(e.target.value))}
        className="w-fit rounded border border-border bg-background px-2 py-1 text-sm"
      >
        {AUTO_DENY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="text-xs text-muted-foreground">
        How long an unanswered confirmation prompt waits before being
        cancelled automatically.
      </div>
    </div>
  );
}
