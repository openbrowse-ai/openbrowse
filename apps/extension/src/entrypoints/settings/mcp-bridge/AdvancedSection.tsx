import { useState } from "react";
import { AlwaysConfirmTasksToggle } from "./AlwaysConfirmTasksToggle";
import { AuditLogTable } from "./AuditLogTable";
import { AutoDenyTimeoutSelect } from "./AutoDenyTimeoutSelect";

/**
 * Advanced section — collapsed by default. Holds the every-RPC log,
 * the auto-cancel timeout, and the global "always confirm" override.
 *
 * Power-user surface; most users never open it. The TOFU / key-
 * mismatch flows are intentionally NOT inside Advanced — they live
 * in the always-visible status pill because they're
 * action-required when present.
 */
export function AdvancedSection() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
        aria-expanded={open}
      >
        <span>Advanced</span>
        <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-6 border-t border-border p-3">
          <section>
            <h3 className="text-sm font-medium">MCP logs</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Every action MCP clients have taken in the last 30 days.
              Filter by client to investigate a specific tool's
              activity. Click a row with an Error or Denied outcome to
              see the raw method and error code.
            </p>
            <div className="mt-3">
              <AuditLogTable />
            </div>
          </section>
          <section>
            <h3 className="text-sm font-medium">Confirmation prompts</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Fine-tune how MCP confirmation prompts behave.
            </p>
            <div className="mt-3 space-y-3">
              <AutoDenyTimeoutSelect />
              <AlwaysConfirmTasksToggle />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
