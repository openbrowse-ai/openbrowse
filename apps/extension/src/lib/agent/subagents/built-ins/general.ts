import type { AgentDefinition } from "../types";

/**
 * Catch-all subagent. Reads, clicks, types, navigates, submits, and
 * writes files. Use for any task that doesn't fit the read-only `explore`.
 *
 * Default isolation: `peer` — own conversation row, own tab group, own
 * OPFS workspace. Users can override per-call to `incognito` for
 * auth-isolated runs.
 */
export const generalAgent: AgentDefinition = {
  slug: "general",
  description:
    "Complete a self-contained task on a page or across tabs — read, click, type, navigate, submit.",
  whenToUse:
    "The catch-all subagent. Use when the task requires actions (clicking, typing, form submission), or for anything that doesn't fit \`explore\`. Can do everything \`explore\` can plus modify pages and write workspace files.",
  defaultIsolation: "peer",
  allowedTools: [
    "readPage",
    "snapshot",
    "screenshot",
    "extract",
    "executeOnPage",
    "read_network_requests",
    "read_console_messages",
    "executePython",
    "scrollPage",
    "selectTab",
    "listTabs",
    "navigate",
    "clickElement",
    "typeInElement",
    "fs",
    "readOpfsFile",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "LS",
    "setTaskTitle",
  ],
  defaultModel: undefined,
  maxSteps: 100,
  color: "warning",
  source: "built-in",
  systemPrompt: `You are a general-purpose subagent for OpenBrowse.

Your job: complete a self-contained task on a web page or across multiple
tabs. You can read, click, type, navigate, submit, and run code on pages.
You can also write files to your workspace if you need to capture artifacts.

Workflow:

1. Read the delegation context for tab handles, URLs, and the task.

2. Call setTaskTitle with a short present-tense description of your phase
   (e.g. "Filling signup form", "Booking the flight"). Update as you move.

3. Take a snapshot to orient. Plan before acting.

4. Execute steps. Re-snapshot when the page changes meaningfully —
   element refs from a stale snapshot are unsafe.

5. If a step requires user approval (auth, payment, dangerous action),
   the approval flow surfaces it to the user automatically. Do not try
   to bypass; if denied, report the blocker and stop.

6. Final text: what you did, what state things are in now, any
   blockers or follow-ups. If you wrote files, cite paths.

Be deliberate. The biggest failure mode is acting before observing.
Re-snapshot is cheap; clicking the wrong button is not.

You have 100 steps to spend.`,
};
