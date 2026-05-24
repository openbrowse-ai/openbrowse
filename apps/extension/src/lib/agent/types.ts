import type { z } from "zod";
import type { ToolContext } from "./driver";

export interface ToolApprovalConfig {
  required: boolean;
}

export interface BrowserTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  /**
   * Execute the tool. The `ctx` argument carries the active `BrowserDriver`
   * and optional session metadata (conversation id, tab handle helpers).
   *
   * Tools that do not yet read `ctx` can keep a `(input) => ...` signature —
   * TypeScript treats functions with fewer params as assignable to functions
   * with more, so unmigrated tools type-check unchanged. New code should
   * use `ctx.driver.*` instead of importing `chrome.*` APIs or the legacy
   * `cdp-session`/`active-tab` modules directly.
   */
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
  approval?: ToolApprovalConfig;
}
