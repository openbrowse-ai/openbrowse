/**
 * Tool: `read_console_messages` — read browser console output captured for a tab.
 *
 * Backed by the per-tab ring buffer in `cdp-capture.ts`. Filtering, limit, and
 * clear semantics are delegated to `readConsole`. When capture isn't active
 * for the tab, the tool returns an empty result with a `note` hinting the
 * agent to act on the page first, rather than throwing.
 */
import { z } from "zod";
import type { BrowserTool } from "../types";
import { resolveTabOrThrow } from "../driver";
import { readConsole } from "../cdp-capture";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to read console messages from (e.g. 't1'). See the tab legend or call listTabs.",
    ),
  pattern: z
    .string()
    .optional()
    .describe(
      "Regex to filter messages by text (e.g. 'error|warning', or an app-specific tag). Strongly recommended — the console is noisy.",
    ),
  onlyErrors: z
    .boolean()
    .optional()
    .describe(
      "If true, return only console.error calls and uncaught exceptions. Default false.",
    ),
  limit: z
    .number()
    .optional()
    .describe(
      "Maximum number of messages to return (most recent N). Defaults to 100.",
    ),
  clear: z
    .boolean()
    .optional()
    .describe(
      "If true, clear the buffer after reading to avoid duplicates on the next call. Default false.",
    ),
});

type Input = z.infer<typeof parameters>;

const consoleEntrySchema = z.object({
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  text: z.string(),
  url: z.string().optional(),
  lineNumber: z.number().optional(),
  ts: z.number(),
});

const outputSchema = z.object({
  tab: z.string(),
  messages: z.array(consoleEntrySchema),
  total: z.number(),
  captured: z.boolean(),
  note: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const readConsoleMessagesTool: BrowserTool<Input, Output> = {
  name: "read_console_messages",
  description:
    "Read browser console output (console.log/info/warn/error) and uncaught exceptions from a tab. Use to debug JavaScript errors, see application logs, or recover console output that executeOnPage drops. Returns messages from the tab's current domain; the buffer is captured continuously while the agent works the tab and cleared on cross-domain navigation. Always pass a `pattern` to avoid pulling in noise. Pass `tab` (handle from the tab legend or listTabs).",
  parameters,
  outputSchema,
  approval: { required: false },
  execute: async ({ tab: handle, pattern, onlyErrors, limit, clear }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    if (tab.id == null) {
      return {
        tab: handle,
        messages: [],
        total: 0,
        captured: false,
        note: "Tab id missing",
      };
    }
    const { messages, total, captured } = readConsole(tab.id as number, {
      ...(pattern !== undefined && { pattern }),
      ...(onlyErrors !== undefined && { onlyErrors }),
      ...(limit !== undefined && { limit }),
      ...(clear !== undefined && { clear }),
    });
    const note = captured
      ? undefined
      : "No console capture for this tab yet. Act on the page, then read again.";
    return {
      tab: handle,
      messages,
      total,
      captured,
      ...(note !== undefined && { note }),
    };
  },
};
