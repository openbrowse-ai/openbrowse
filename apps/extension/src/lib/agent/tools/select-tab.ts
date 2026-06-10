import { z } from "zod";
import { bindTabByHandle } from "../driver";
import type { BrowserTool } from "../types";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle from listTabs (e.g. 't1'). Use this to bind a tab the agent didn't open (e.g. one the user already had) into the conversation so subsequent tool calls can address it.",
    ),
});

type Input = z.infer<typeof parameters>;

type Output = { selected: true; tab: string };

export const selectTabTool: BrowserTool<Input, Output> = {
  name: "selectTab",
  description:
    "Bind an external (user-opened) tab into this conversation so it appears in the tab legend and can be passed as the `tab` arg to other tools. Does NOT switch the user's visible tab. Use handles from listTabs.",
  parameters,
  execute: async ({ tab }, ctx) => {
    // Shared resolve (with numeric fallback) + verify + bind. Returns null
    // if the handle doesn't map to a live tab.
    const tabId = await bindTabByHandle(ctx, tab);
    if (tabId == null) {
      throw new Error(
        `Tab handle "${tab}" not found. Use listTabs to see available tabs.`,
      );
    }

    // selectTab additionally pins the bound tab as the agent's working target.
    await ctx.driver.setActiveTab(tabId);
    return { selected: true, tab };
  },
};
