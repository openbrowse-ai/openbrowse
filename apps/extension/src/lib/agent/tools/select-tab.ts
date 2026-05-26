import { z } from "zod";
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
    let tabId = ctx.session?.resolveHandle?.(tab);

    // Fallback: try parsing as numeric tab ID for backward compat
    if (tabId == null) {
      const parsed = parseInt(tab, 10);
      if (!Number.isNaN(parsed)) tabId = parsed;
    }

    if (tabId == null) {
      throw new Error(`Tab handle "${tab}" not found. Use listTabs to see available tabs.`);
    }

    // Verify the tab exists by listing tabs.
    const tabs = await ctx.driver.listTabs();
    const target = tabs.find((t) => t.id === tabId);
    if (!target) throw new Error(`Tab ${tabId} not found`);

    // Always fold into the conversation's owned tabs so the tab appears in
    // the agent's tab legend on subsequent turns. Binding into the group (if
    // one exists) is a side effect of the same call.
    await ctx.session?.bindActiveTabToConversation?.(tabId);

    await ctx.driver.setActiveTab(tabId);
    return { selected: true, tab };
  },
};
