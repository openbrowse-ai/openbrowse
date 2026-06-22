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
      "Python source. Paths in Python match what the agent's fs tools see: " +
        "the conversation workspace is at `conversations/<conversationId>/workspace` " +
        "(read/write, and the cwd — relative paths like `data.csv` resolve here). " +
        "When a space is active, the shared space workspace is at " +
        "`spaces/<spaceId>/workspace` (read-only). Skills are at `/skills` (read-only). " +
        "Code runs at module level: DO NOT use `return`; the value of the last " +
        "expression is returned. Top-level `await` is supported (e.g. " +
        "`await micropip.install('X')`).",
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
      "Execute Python (CPython 3 via Pyodide) inside the browser. Paths in " +
      "Python match the agent's fs tools verbatim: the conversation workspace " +
      "lives at `conversations/<conversationId>/workspace` (read/write, and " +
      "the cwd), the shared space workspace (when set) at `spaces/<spaceId>/workspace` " +
      "(read-only), and `/skills` is read-only. State " +
      "(imports, globals) persists across calls in the same conversation. " +
      "Network is OFF by default — set allow_network: true to install " +
      "packages with micropip or hit the internet. Prefer the dedicated fs " +
      "tools (Read/Write/Edit/Glob/Grep/LS) for trivial single-file ops. " +
      "Code runs at module level (no top-level return) and top-level await is supported. " +
      "For the runtime package list and Pyodide-specific idioms, load the `python-env` skill.",
    parameters,
    approval: { required: true },
    execute: async (
      { code, timeout_ms, reset_state, allow_network },
      ctx,
    ) => {
      // Resolve the conversation id from the per-call ToolContext, not a
      // build-time closure. The parent agent's wrapper sets this from the
      // live agentConversationId; a subagent injects its own (child) ctx.
      // This is what makes a brand-new chat (whose transport was built
      // before the conversation row existed) and subagent workspaces
      // resolve correctly.
      const conversationId = ctx.session?.conversationId ?? null;
      const spaceId = ctx.session?.spaceId ?? null;
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
          spaceId,
          code,
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
