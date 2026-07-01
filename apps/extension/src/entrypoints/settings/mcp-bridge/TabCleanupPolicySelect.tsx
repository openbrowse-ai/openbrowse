import { useCallback, useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { resolveTabCleanupPolicy } from "@/entrypoints/background/mcp-bridge/cleanup-policy";
import type { TabCleanupPolicy } from "@/entrypoints/background/mcp-bridge/cleanup-policy";

/**
 * Preferences select: what OpenBrowse does with MCP-opened tabs when
 * a task ends. Replaces the prior `KeepTabsAfterCancelToggle`
 * boolean. Persists to `Settings.mcpAfterTaskTabPolicy`; the legacy
 * `mcpKeepTabsAfterCancel` boolean is honored on first read via the
 * migration in `cleanup.ts:resolveTabCleanupPolicy` but never
 * written to once the user picks an explicit value here.
 *
 * The select is the single user-facing surface for tab cleanup
 * behavior. `handlers/task.ts`'s terminal-cleanup path
 * (`runCleanupForTask`) reads the resolved policy at the moment a
 * task ends — changes here apply to subsequent terminals only.
 */
export const TAB_CLEANUP_OPTIONS: ReadonlyArray<{
  value: TabCleanupPolicy;
  label: string;
  caption: string;
}> = [
  {
    value: "always-close",
    label: "Close tabs when the task ends",
    caption:
      "Cleanest behavior — tabs the agent opened are closed when the task completes, errors, or stops. The full chat transcript is still saved.",
  },
  {
    value: "close-on-cancel-only",
    label: "Close tabs only when I stop the task",
    caption:
      "Successful and errored tasks leave their tabs open for review; only Stop / host-cancel triggers cleanup.",
  },
  {
    value: "keep",
    label: "Never close tabs automatically",
    caption: "OpenBrowse never closes MCP-opened tabs on its own.",
  },
] as const;

/**
 * Pure helper, exported for unit testing: derive the currently-selected
 * policy from a Settings snapshot, applying the same migration that
 * the runtime cleanup path uses.
 */
export function resolveSelectedPolicy(s: {
  mcpAfterTaskTabPolicy?: TabCleanupPolicy;
  mcpKeepTabsAfterCancel?: boolean;
}): TabCleanupPolicy {
  return resolveTabCleanupPolicy(s);
}

export function TabCleanupPolicySelect() {
  const [value, setValue] = useState<TabCleanupPolicy | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await storage.getSettings();
      setValue(resolveSelectedPolicy(s));
    })();
  }, []);

  const onChange = useCallback(async (next: TabCleanupPolicy) => {
    setValue(next);
    await storage.updateSettings((s) => ({
      ...s,
      mcpAfterTaskTabPolicy: next,
    }));
  }, []);

  if (value === null) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  const selectedCaption =
    TAB_CLEANUP_OPTIONS.find((o) => o.value === value)?.caption ?? "";

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="mcp-tab-cleanup-select" className="text-sm">
        After a task ends
      </label>
      <select
        id="mcp-tab-cleanup-select"
        value={value}
        onChange={(e) =>
          void onChange(e.target.value as TabCleanupPolicy)
        }
        className="w-fit rounded border border-border bg-background px-2 py-1 text-sm"
      >
        {TAB_CLEANUP_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="text-xs text-muted-foreground">{selectedCaption}</div>
    </div>
  );
}
