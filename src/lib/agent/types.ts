import type { z } from "zod";

export interface ToolApprovalConfig {
  required: boolean;
}

export interface BrowserTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TInput>;
  execute: (input: TInput) => Promise<TOutput>;
  approval?: ToolApprovalConfig;
}
