import { z } from "zod";
import type { BrowserTool } from "../types";
import { emitVfsChange } from "@/lib/vfs/events";
import {
  executePythonRPC,
  warmupPythonRPC,
  type PythonExecuteResponse,
} from "@/lib/python/messages";

const parameters = z.object({
  code: z
    .string()
    .describe(
      "Python source. Workspace files are at /workspace (cwd, read/write). " +
        "Skills are at /skills (read-only). The variable __input is the " +
        "parsed JSON of `input` if provided. Code runs at module level: " +
        "DO NOT use `return`; the value of the last expression is returned. " +
        "Top-level `await` is supported (e.g. `await micropip.install('X')`).",
    ),
  input: z
    .string()
    .optional()
    .describe(
      "JSON-encoded data made available as the Python global __input. If not " +
        "valid JSON, it's passed as a raw string.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Hard timeout in ms (default 30000, max 300000)."),
  reset_state: z
    .boolean()
    .optional()
    .describe(
      "If true, clears all user-defined globals before this run. The Python " +
        "interpreter and previously imported modules stay loaded, so this is " +
        "much cheaper than disposing the worker.",
    ),
  allow_network: z
    .boolean()
    .optional()
    .describe(
      "Permit outbound HTTP from this run. Off by default. Required for " +
        "`micropip.install(...)`, `urllib`, and `pyodide.http.pyfetch`.",
    ),
});

type Input = z.infer<typeof parameters>;

type Output = {
  ok: boolean;
  result?: unknown;
  stdout: string;
  stderr: string;
  error?: string;
  errorKind?: PythonExecuteResponse["errorKind"];
  timings: PythonExecuteResponse["timings"];
};

export function createPythonTool(): BrowserTool<Input, Output> {
  return {
    name: "executePython",
    description:
      "Execute Python (CPython 3 via Pyodide) inside the browser, with " +
      "access to the conversation's OPFS workspace at /workspace and the " +
      "shared skills directory at /skills (read-only). State " +
      "(imports, globals) persists across calls in the same conversation. " +
      "Network is OFF by default — set allow_network: true to install " +
      "packages with micropip or hit the internet. Prefer the dedicated fs " +
      "tools (Read/Write/Edit/Glob/Grep/LS) for trivial single-file ops. " +
      "Code runs at module level (no top-level return) and top-level await is supported. " +
      "For the runtime package list and Pyodide-specific idioms, load the `python-env` skill.",
    parameters,
    approval: { required: true },
    execute: async (
      { code, input, timeout_ms, reset_state, allow_network },
      ctx,
    ) => {
      // Resolve the conversation id from the per-call ToolContext, not a
      // build-time closure. The parent agent's wrapper sets this from the
      // live agentConversationId; a subagent injects its own (child) ctx.
      // This is what makes a brand-new chat (whose transport was built
      // before the conversation row existed) and subagent workspaces
      // resolve correctly.
      const conversationId = ctx.session?.conversationId ?? null;
      if (!conversationId) {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          error: "No conversation context; executePython requires an active conversation.",
          timings: { runMs: 0 },
        };
      }
      try {
        const res = await executePythonRPC({
          conversationId,
          code,
          input,
          timeoutMs: timeout_ms,
          resetState: reset_state,
          allowNetwork: allow_network,
        });
        // Coarse VFS change emit; matches what fs.ts does on every write.
        emitVfsChange(`conversations/${conversationId}/workspace`);
        return res;
      } catch (err) {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          error: err instanceof Error ? err.message : String(err),
          errorKind: "Internal",
          timings: { runMs: 0 },
        };
      }
    },
  };
}

/**
 * Optional helper for callers (e.g., a "warm up Python" UI button) to
 * preload Pyodide for a conversation without running any code.
 */
export async function warmupPython(conversationId: string) {
  return warmupPythonRPC(conversationId);
}
