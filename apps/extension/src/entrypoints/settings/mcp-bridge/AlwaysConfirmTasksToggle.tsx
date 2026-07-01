import { useCallback, useEffect, useState } from "react";
import { storage } from "@/lib/storage";

/**
 * Preferences checkbox: forces every MCP `task` call to prompt for
 * user confirmation, overriding the per-host policy. When on, even
 * a host the user has set to "Trust automatically" will require a
 * per-action approval for tasks (other tool calls — `read_page`,
 * `screenshot`, etc. — still respect the per-host policy).
 *
 * Off by default. Surfaced in Advanced for users who want a
 * belt-and-suspenders escalation without rewriting every host's
 * confirmation setting individually.
 */
export function AlwaysConfirmTasksToggle() {
  const [value, setValue] = useState<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await storage.getSettings();
      setValue(s.mcpAlwaysConfirmTasks ?? false);
    })();
  }, []);

  const onChange = useCallback(async (next: boolean) => {
    setValue(next);
    await storage.updateSettings((s) => ({
      ...s,
      mcpAlwaysConfirmTasks: next,
    }));
  }, []);

  if (value === null) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => void onChange(e.target.checked)}
        className="mt-0.5 size-4"
      />
      <span>
        <span>Always confirm before AI tasks run</span>
        <span className="block text-xs text-muted-foreground">
          Override the per-MCP-client confirmation setting for tasks. Every
          AI task will require your approval before it runs, regardless of
          whether you've set a client to trust automatically.
        </span>
      </span>
    </label>
  );
}
