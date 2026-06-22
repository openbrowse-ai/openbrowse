import { z } from "zod";
import type { BrowserTool } from "../types";
import { resolveTabOrThrow } from "../driver";
import { invalidateRefs } from "../ref-store";
import { persistReturnValue } from "./save-as";
import { readSiteSkillScript, parseScriptDesc } from "../../skills/site-skill-scripts";

const TIMEOUT_MS = 30_000;

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to execute against (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
  code: z
    .string()
    .optional()
    .describe(
      "JavaScript function body to execute in the page. Has full access to document, window, and page globals. Access passed data via `args`. Use `return` to produce output. Return value must be JSON-serializable; when `saveAs` is set, return any JSON-serializable value (auto-stringified) or `{ __binary_b64: \"...\" }` for binary content. Provide EITHER `code` or `scriptRef`, not both.",
    ),
  kind: z
    .enum(["read", "write"])
    .optional()
    .describe(
      "Required when `code` is set; ignored when `scriptRef` is set. Whether this script READS page state (returns data; no DOM/storage/network mutation, no clicks, no fetch) or WRITES (mutates DOM, types into fields, dispatches events, calls fetch, modifies storage, navigates). Read-shaped scripts skip approval on ANY origin (a static AST check on the body is the trust mechanism — same exfiltration surface as snapshot/readPage, both ungated). Write-shaped scripts skip approval ONLY on user-allowlisted origins, otherwise require approval (in Ask mode) or must target an in-plan site (in Plan mode). When in doubt, declare 'write' — a misclassified read prompts unnecessarily but a misclassified write would silently bypass the gate.",
    ),
  scriptRef: z
    .object({
      skill: z
        .string()
        .describe("Site skill the script belongs to — its domain (e.g. 'linkedin.com')."),
      script: z
        .string()
        .describe("Script filename within the skill (e.g. 'list-recent-posts.js')."),
    })
    .optional()
    .describe(
      "Run a saved site-skill script by reference instead of inlining `code`. The body is loaded from the skill's files and never enters your context. ALWAYS prefer this over writing inline `code` when the '## Site skills for open tabs' section lists a matching script. Pass inputs the script expects via `args`. Provide EITHER `code` OR `scriptRef`, never both.",
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
        "instead of returning the value to the chat. Accepted return shapes: " +
        "a string (written as text), any JSON-serializable value " +
        "(object/array/number/boolean/null — pretty-printed JSON), or " +
        "{ __binary_b64: string } (base64-decoded and written as bytes). " +
        "On success the tool returns { tab, path, bytes, sha256 } — the data " +
        "itself is NOT echoed back. Use this for any payload larger than a " +
        "few KB to keep chat context clean.",
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
  /**
   * Present only when the call ran a site-skill script by reference. Carries
   * the reference plus its `@desc` header (NOT the body) so the UI can render
   * a distinct "ran a saved script" card without re-reading OPFS. Keeping the
   * body out preserves the by-reference contract (it never enters context).
   */
  ranScript: z
    .object({
      skill: z.string(),
      script: z.string(),
      desc: z.string().nullable(),
    })
    .optional(),
});
type Output = z.infer<typeof outputSchema>;

export const executeOnPageTool: BrowserTool<Input, Output> = {
  name: "executeOnPage",
  description:
    "Execute JavaScript in a tab's page context with full DOM access. Pass `tab` (handle from the tab legend or listTabs), `kind` ('read' or 'write' — required when `code` is set), and EITHER inline `code` OR a `scriptRef` to a saved site-skill script. On a domain that has a site skill (see '## Site skills for open tabs'), check its scripts FIRST and use `scriptRef` if one matches — its body runs without filling your context. Otherwise write inline `code`. Read-shaped inline `code` skips approval on ANY origin (a static check on the body is the trust mechanism). Write-shaped inline `code` skips approval ONLY on user-allowlisted origins, otherwise prompts. A `scriptRef` run of a saved script does NOT require approval (it's trusted — you don't need to Read the body first, the script catalog is its contract). Use for complex DOM manipulation or page JavaScript state beyond what readPage/clickElement/typeInElement provide. For payloads larger than a few KB, set `saveAs` to write directly to /workspace instead of round-tripping through the chat.",
  parameters,
  outputSchema,
  approval: { required: true },
  execute: async ({ tab: handle, code, kind, scriptRef, args, saveAs }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    if (tab.id == null) {
      return { tab: handle, error: "Tab id missing" };
    }

    // Resolve the code to run: a saved site-skill script (by reference) or inline.
    let scriptBody: string;
    let ranScript: Output["ranScript"];
    if (scriptRef) {
      if (code) {
        return {
          tab: handle,
          error:
            "Provide EITHER `code` or `scriptRef`, not both. Use `scriptRef` to run a saved script, or `code` for an ad-hoc snippet.",
        };
      }
      const loaded = await readSiteSkillScript(scriptRef.skill, scriptRef.script);
      if (loaded == null) {
        return {
          tab: handle,
          error: `No script '${scriptRef.script}' in site skill '${scriptRef.skill}'. Pass inline \`code\` instead (a background curator saves reusable scripts after the task).`,
        };
      }
      scriptBody = loaded;
      ranScript = {
        skill: scriptRef.skill,
        script: scriptRef.script,
        desc: parseScriptDesc(loaded),
      };
    } else if (code) {
      if (!kind) {
        return {
          tab: handle,
          error: "Inline `code` requires `kind` ('read' or 'write'). See tool description.",
        };
      }
      scriptBody = code;
    } else {
      return {
        tab: handle,
        error: "Provide either `code` (inline) or `scriptRef` (a saved script).",
      };
    }

    let parsedArgs: unknown = null;
    if (args) {
      try { parsedArgs = JSON.parse(args); } catch { parsedArgs = args; }
    }

    const expression = `(async function() { const args = ${JSON.stringify(parsedArgs)}; ${scriptBody} })()`;

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
      return { tab: handle, error: "Execution timed out after 30s", ranScript };
    }

    if (evalResult.exceptionDetails) {
      const ex = evalResult.exceptionDetails;
      const msg = ex.exception?.description ?? ex.text ?? "Unknown error";
      // A thrown exception can still leave the DOM partially mutated, so
      // invalidate refs here too before returning.
      invalidateRefs(tab.id);
      return { tab: handle, error: msg, ranScript };
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
        return { tab: handle, error: persisted.error, ranScript };
      }
      // IMPORTANT: do NOT include the data in the result — the whole point
      // of saveAs is to keep large payloads out of the chat context.
      // `ranScript` is metadata-only (no body), safe to surface.
      return {
        tab: handle,
        path: persisted.path,
        bytes: persisted.bytes,
        sha256: persisted.sha256,
        ranScript,
      };
    }

    return { tab: handle, result: returnValue, ranScript };
  },
};
