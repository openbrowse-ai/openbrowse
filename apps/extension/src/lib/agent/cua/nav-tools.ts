import { tool } from "ai";
import { z } from "zod";
import type { CanonicalAction } from "./actions";
import { cuaToModelOutput, type CuaActionOutput } from "./cua-loop";

/** Output shape of every nav tool — matches CuaActionOutput. Declared so the
 *  AI SDK can infer the `toModelOutput` input type (without it, `tool()`
 *  resolves the output to `never`). */
const cuaActionOutputSchema = z.object({
  imageDataUrl: z.string().optional(),
  currentUrl: z.string().optional(),
  noChange: z.boolean().optional(),
});

/**
 * Sibling navigation tools for the CUA loop. The Anthropic computer tool has
 * no URL/back/forward actions and cannot reach browser chrome, so we expose
 * these as ordinary AI-SDK tools (matching Gemini/OpenAI CUA). Each returns a
 * post-navigation screenshot via the shared `runAction` + `cuaToModelOutput`.
 */
export function buildCuaNavTools(
  runAction: (action: CanonicalAction) => Promise<CuaActionOutput>,
) {
  return {
    navigate: tool({
      description:
        "Navigate the current tab directly to a URL (like typing in the address bar). Use this instead of hunting for links. Returns a screenshot of the loaded page.",
      inputSchema: z.object({
        url: z
          .string()
          .describe("Absolute URL, e.g. https://www.linkedin.com/feed/"),
      }),
      outputSchema: cuaActionOutputSchema,
      execute: async ({ url }) => runAction({ kind: "navigate", url }),
      toModelOutput: cuaToModelOutput,
    }),
    goBack: tool({
      description:
        "Go back to the previous page in browser history (like the Back button). Returns a screenshot.",
      inputSchema: z.object({}),
      outputSchema: cuaActionOutputSchema,
      execute: async () => runAction({ kind: "goBack" }),
      toModelOutput: cuaToModelOutput,
    }),
    goForward: tool({
      description:
        "Go forward to the next page in browser history (like the Forward button). Returns a screenshot.",
      inputSchema: z.object({}),
      outputSchema: cuaActionOutputSchema,
      execute: async () => runAction({ kind: "goForward" }),
      toModelOutput: cuaToModelOutput,
    }),
  };
}

