import { z } from "zod";
import type { BrowserTool } from "../types";
import { resolveTabOrThrow } from "../driver";
import { invalidateRefs } from "../ref-store";
import { persistReturnValue } from "./save-as";

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
      "JavaScript function body to execute in the page. Has full access to document, window, and page globals. Access passed data via `args`. Use `return` to produce output. Return value must be JSON-serializable; when `saveAs` is set, return either a string (written as text) or `{ __binary_b64: \"...\" }` for binary content.",
    ),
  args: z
    .string()
    .optional()
    .describe("JSON-encoded data passed to the code, accessible as `args` (auto-parsed)"),
  saveAs: z
    .string()
    .optional()
    .describe(
      "If set, write the script's return value to this path under /workspace " +
        "instead of returning the value to the chat. The script must return a " +
        "string (written as text) or an object of shape { __binary_b64: string } " +
        "(base64-decoded and written as bytes). On success the tool returns " +
        "{ tab, path, bytes, sha256 } — the data itself is NOT echoed back. " +
        "Use this for any payload larger than a few KB to keep chat context clean.",
    ),
});

type Input = z.infer<typeof parameters>;
const outputSchema = z.object({
  tab: z.string(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  path: z.string().optional(),
  bytes: z.number().optional(),
  sha256: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const executeOnPageTool: BrowserTool<Input, Output> = {
  name: "executeOnPage",
  description:
    "Execute JavaScript in a tab's page context with full DOM access. Pass `tab` (handle from the tab legend or listTabs). Requires user approval before each execution. Use when you need complex DOM manipulation or access to page JavaScript variables/state beyond what readPage/clickElement/typeInElement provide. For payloads larger than a few KB, set `saveAs` to write directly to /workspace instead of round-tripping through the chat.",
  parameters,
  outputSchema,
  approval: { required: true },
  execute: async ({ tab: handle, code, args, saveAs }, ctx) => {
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

    const returnValue = evalResult.result?.value ?? null;

    if (saveAs) {
      const conversationId = ctx.session?.conversationId ?? null;
      if (!conversationId) {
        return {
          tab: handle,
          error:
            "saveAs requires an active conversation; none was bound to this tool call.",
        };
      }
      const persisted = await persistReturnValue({
        conversationId,
        saveAs,
        returnValue,
        source: "executeOnPage",
      });
      if (!persisted.ok) {
        return { tab: handle, error: persisted.error };
      }
      // IMPORTANT: do NOT include the data in the result — the whole point
      // of saveAs is to keep large payloads out of the chat context.
      return {
        tab: handle,
        path: persisted.path,
        bytes: persisted.bytes,
        sha256: persisted.sha256,
      };
    }

    return { tab: handle, result: returnValue };
  },
};
