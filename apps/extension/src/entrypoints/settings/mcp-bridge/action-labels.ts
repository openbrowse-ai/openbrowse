import type { AuditDbEntry } from "@/lib/mcp-bridge-audit-db";

/**
 * Friendly human-readable label for each MCP RPC method, used in
 * the MCP Logs table.
 *
 * The raw RPC method names (`task`, `read_page`, `screenshot`, etc.)
 * are technically correct but unfriendly to non-developers. The
 * mapping below is intentionally verbose ("Ran a task" not just
 * "task") so the column reads like a list of actions the assistant
 * performed.
 *
 * For unknown methods we surface the raw name verbatim — better to
 * show something unfamiliar than to silently lie. The raw method is
 * always available via the `(?)` tooltip on each row.
 */
const ACTION_LABELS: Record<string, string> = {
  task: "Ran a task",
  cancel_task: "Cancelled a task",
  read_page: "Read a page",
  screenshot: "Took a screenshot",
  open_url: "Opened a URL",
  get_context: "Asked about your browser",
  list_windows: "Listed your windows",
  list_spaces: "Listed your spaces",
};

export function formatActionLabel(method: string): string {
  return ACTION_LABELS[method] ?? method;
}

/**
 * Friendly outcome label. The audit DB stores codified outcomes;
 * users see the verb forms.
 */
export function formatOutcomeLabel(o: AuditDbEntry["outcome"]): string {
  switch (o) {
    case "ok":
      return "Success";
    case "error":
      return "Error";
    case "denied":
      return "Denied";
    case "rate_limited":
      return "Rate limited";
    default: {
      const _exhaustive: never = o;
      return _exhaustive;
    }
  }
}
