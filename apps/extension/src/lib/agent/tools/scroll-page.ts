import { z } from "zod";
import { getActiveUserTab, sendToContentScript } from "../active-tab";
import { invalidateRefs } from "../ref-store";
import type { BrowserTool } from "../types";

const parameters = z.object({
  direction: z
    .enum(["up", "down"])
    .describe("Direction to scroll"),
  amount: z
    .number()
    .optional()
    .describe("Pixels to scroll (default: 600, roughly one viewport)"),
});

type Input = z.infer<typeof parameters>;

type Output = { scrolled: true; direction: string; amount: number };

export const scrollPageTool: BrowserTool<Input, Output> = {
  name: "scrollPage",
  description:
    "Scroll the user's active page up or down. Useful for revealing content below the fold or navigating back to the top.",
  parameters,
  execute: async ({ direction, amount }) => {
    const tab = await getActiveUserTab();
    const pixels = amount ?? 600;

    const result = await sendToContentScript<{ success: boolean; error?: string }>(tab.id!, {
      type: "CHAT_SCROLL_PAGE",
      direction,
      amount: pixels,
    });

    if (!result.success)
      throw new Error(result.error ?? "Failed to scroll");
    invalidateRefs(tab.id!);
    return { scrolled: true, direction, amount: pixels };
  },
};
