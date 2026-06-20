import { z } from "zod";
import type { BrowserTool } from "../types";
import { executeInSandbox } from "./sandbox";
import { persistReturnValue } from "./save-as";

const parameters = z.object({
  code: z
    .string()
    .describe(
      "JavaScript code to execute. Top-level `await` is supported. Access input data via `__input`. Return a value with `return`. Example: `const r = await fetch(url); return await r.json();`",
    ),
  input: z
    .string()
    .optional()
    .describe("JSON-encoded data to pass to the code. Accessible as `__input` in your code. Example: '{\"url\": \"https://example.com\"}'"),
  saveAs: z
    .string()
    .optional()
    .describe(
      "If set, write the script's return value to this path under /workspace " +
        "instead of returning it to the chat. Accepted return shapes: a " +
        "string (written as text), any JSON-serializable value " +
        "(object/array/number/boolean/null — pretty-printed JSON), or " +
        "{ __binary_b64: string } (base64-decoded and written as bytes). " +
        "On success the tool returns { logs, path, bytes, sha256 } — the " +
        "data itself is NOT echoed back. Use this for any payload larger " +
        "than a few KB to keep chat context clean.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe(
      "Override the default 30 000 ms execution timeout. Useful for batched " +
        "external fetches that hit rate limits and need to retry-with-backoff. " +
        "Maximum 120 000 ms.",
    ),
});

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  result: z.unknown().optional(),
  logs: z.array(z.string()),
  error: z.string().optional(),
  path: z.string().optional(),
  bytes: z.number().optional(),
  sha256: z.string().optional(),
});
type Output = z.infer<typeof outputSchema>;

export const executeCodeTool: BrowserTool<Input, Output> = {
  name: "executeCode",
  description:
    "Execute JavaScript in an isolated sandbox (Web Worker). Has access to fetch() for network requests but NO DOM access. Top-level `await` is supported. Use for computation, data transforms, and API calls. Pass data via `input`, access it as `__input` in your code. Use `return` to produce output. For payloads larger than a few KB, set `saveAs` to write directly to /workspace instead of round-tripping through the chat. Default timeout 30s; set `timeout_ms` (≤120000) for slow batched work.",
  parameters,
  outputSchema,
  execute: async ({ code, input, saveAs, timeout_ms }, ctx) => {
    let parsed: unknown;
    if (input) {
      try { parsed = JSON.parse(input); } catch { parsed = input; }
    }
    // When `saveAs` is set, the result goes straight to /workspace, so the
    // sandbox's 1 MB JSON-output cap is counterproductive — disable it.
    const sandboxResult = await executeInSandbox(code, parsed, {
      unboundedOutput: !!saveAs,
      ...(timeout_ms !== undefined && { timeoutMs: timeout_ms }),
    });
    if (sandboxResult.error || !saveAs) {
      return sandboxResult;
    }
    const conversationId = ctx.session?.conversationId ?? null;
    if (!conversationId) {
      return {
        ...sandboxResult,
        error:
          "saveAs requires an active conversation; none was bound to this tool call.",
      };
    }
    const persisted = await persistReturnValue({
      conversationId,
      saveAs,
      returnValue: sandboxResult.result,
      source: "executeCode",
    });
    if (!persisted.ok) {
      return { logs: sandboxResult.logs, error: persisted.error };
    }
    // Drop `result` to keep the data out of chat context.
    return {
      logs: sandboxResult.logs,
      path: persisted.path,
      bytes: persisted.bytes,
      sha256: persisted.sha256,
    };
  },
};
