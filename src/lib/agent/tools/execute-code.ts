import { z } from "zod";
import type { BrowserTool } from "../types";
import { executeInSandbox } from "./sandbox";

const parameters = z.object({
  code: z
    .string()
    .describe(
      "JavaScript code to execute. Access input data via `__input`. Return a value with `return`. Example: `const data = await fetch(url); return await data.json();`",
    ),
  input: z
    .string()
    .optional()
    .describe("JSON-encoded data to pass to the code. Accessible as `__input` in your code. Example: '{\"url\": \"https://example.com\"}'"),
});

type Input = z.infer<typeof parameters>;
type Output = { result?: unknown; logs: string[]; error?: string };

export const executeCodeTool: BrowserTool<Input, Output> = {
  name: "executeCode",
  description:
    "Execute JavaScript in an isolated sandbox (Web Worker). Has access to fetch() for network requests but NO DOM access. Use for computation, data transforms, and API calls. Pass data via `input`, access it as `__input` in your code. Use `return` to produce output.",
  parameters,
  execute: async ({ code, input }) => {
    let parsed: unknown;
    if (input) {
      try { parsed = JSON.parse(input); } catch { parsed = input; }
    }
    return executeInSandbox(code, parsed);
  },
};
