import { z } from "zod";
import type { BrowserTool } from "../types";
import { resolveTabOrThrow } from "../driver";
import { invalidateRefs } from "../ref-store";

const TIMEOUT_MS = 30_000;

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to execute against (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
  code: z
    .string()
    .describe(
      "JavaScript function body to execute in the page. Has full access to document, window, and page globals. Access passed data via `args`. Use `return` to produce output. Return value must be JSON-serializable.",
    ),
  args: z
    .string()
    .optional()
    .describe("JSON-encoded data passed to the code, accessible as `args` (auto-parsed)"),
});

type Input = z.infer<typeof parameters>;
const outputSchema = z.object({
  tab: z.string(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const executeOnPageTool: BrowserTool<Input, Output> = {
  name: "executeOnPage",
  description:
    "Execute JavaScript in a tab's page context with full DOM access. Pass `tab` (handle from the tab legend or listTabs). Requires user approval before each execution. Use when you need complex DOM manipulation or access to page JavaScript variables/state beyond what readPage/clickElement/typeInElement provide.",
  parameters,
  outputSchema,
  approval: { required: true },
  execute: async ({ tab: handle, code, args }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    if (tab.id == null) {
      return { tab: handle, error: "Tab id missing" };
    }

    let parsedArgs: unknown = null;
    if (args) {
      try { parsedArgs = JSON.parse(args); } catch { parsedArgs = args; }
    }

    const expression = `(async function() { const args = ${JSON.stringify(parsedArgs)}; ${code} })()`;

    const evalResult = await Promise.race([
      ctx.driver.sendCommand<{
        result?: { type: string; value?: unknown; description?: string };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      }>(tab.id, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), TIMEOUT_MS),
      ),
    ]);

    if (evalResult === "timeout") {
      // The script may have partially run and mutated/replaced DOM nodes
      // before timing out. Clear refs so the agent re-snapshots.
      invalidateRefs(tab.id);
      return { tab: handle, error: "Execution timed out after 30s" };
    }

    if (evalResult.exceptionDetails) {
      const ex = evalResult.exceptionDetails;
      const msg = ex.exception?.description ?? ex.text ?? "Unknown error";
      // A thrown exception can still leave the DOM partially mutated, so
      // invalidate refs here too before returning.
      invalidateRefs(tab.id);
      return { tab: handle, error: msg };
    }

    // Arbitrary JS may have mutated/replaced DOM nodes, and (unlike
    // click/type) we take no post-action snapshot to refresh the map. Clear
    // refs so the agent re-snapshots before acting; stable ids will be
    // recomputed from the new tree.
    invalidateRefs(tab.id);
    return { tab: handle, result: evalResult.result?.value ?? null };
  },
};
