import { z } from "zod";
import type { BrowserTool } from "../types";
import { invalidateRefs } from "../ref-store";

const TIMEOUT_MS = 30_000;

const parameters = z.object({
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
  result: z.unknown().optional(),
  error: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const executeOnPageTool: BrowserTool<Input, Output> = {
  name: "executeOnPage",
  description:
    "Execute JavaScript in the active tab's page context with full DOM access. Requires user approval before each execution. Use when you need complex DOM manipulation or access to page JavaScript variables/state beyond what readPage/clickElement/typeInElement provide.",
  parameters,
  outputSchema,
  approval: { required: true },
  execute: async ({ code, args }, ctx) => {
    const tab = await ctx.driver.getActiveTab();
    if (tab.id == null) {
      return { error: "No active tab available" };
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
      return { error: "Execution timed out after 30s" };
    }

    if (evalResult.exceptionDetails) {
      const ex = evalResult.exceptionDetails;
      const msg = ex.exception?.description ?? ex.text ?? "Unknown error";
      return { error: msg };
    }

    // Assume successful execution may have modified the DOM
    invalidateRefs(tab.id);
    return { result: evalResult.result?.value ?? null };
  },
};
