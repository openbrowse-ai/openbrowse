import { z } from "zod";
import { resolveTabOrThrow } from "../driver";
import type { BrowserTool } from "../types";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to scroll (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
  direction: z
    .enum(["up", "down"])
    .describe("Direction to scroll"),
  amount: z
    .number()
    .optional()
    .describe("Pixels to scroll (default: 600, roughly one viewport)"),
});

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  tab: z.string(),
  scrolled: z.literal(true),
  direction: z.string(),
  amount: z.number(),
});
type Output = z.infer<typeof outputSchema>;

export const scrollPageTool: BrowserTool<Input, Output> = {
  name: "scrollPage",
  description:
    "Scroll a page up or down. Pass `tab` (handle from the tab legend or listTabs). Useful for revealing content below the fold or navigating back to the top.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle, direction, amount }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const pixels = amount ?? 600;

    const result = await ctx.driver.sendToContentScript<{
      success: boolean;
      error?: string;
    }>(tab.id, {
      type: "CHAT_SCROLL_PAGE",
      direction,
      amount: pixels,
    });

    if (!result.success)
      throw new Error(result.error ?? "Failed to scroll");
    // Don't invalidate refs: scrolling moves elements within the page but
    // doesn't detach them, and content-stable refs survive a re-snapshot.
    // The agent's next snapshot refreshes positions via the ref-store merge.
    return { tab: handle, scrolled: true, direction, amount: pixels };
  },
};
