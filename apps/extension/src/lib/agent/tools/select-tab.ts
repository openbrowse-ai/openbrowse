import { z } from "zod";
import { chatDb } from "@/lib/chat-db";
import type { BrowserTool } from "../types";

const parameters = z.object({
  tab: z
    .string()
    .describe("Tab handle from listTabs (e.g. 't1', 't2')"),
});

type Input = z.infer<typeof parameters>;

type Output = { selected: true; tab: string };

export const selectTabTool: BrowserTool<Input, Output> = {
  name: "selectTab",
  description:
    "Set which tab tools like readPage/clickElement/typeInElement/snapshot should target. Does NOT switch the user's visible tab. Use handles from listTabs.",
  parameters,
  execute: async ({ tab }, ctx) => {
    const conversationId = ctx.session?.conversationId ?? null;

    let tabId = ctx.session?.resolveHandle?.(tab);

    // Fallback: try parsing as numeric tab ID for backward compat
    if (tabId == null) {
      const parsed = parseInt(tab, 10);
      if (!Number.isNaN(parsed)) tabId = parsed;
    }

    if (tabId == null) {
      throw new Error(`Tab handle "${tab}" not found. Use listTabs to see available tabs.`);
    }

    // Verify the tab exists and isn't an internal page by listing tabs.
    const tabs = await ctx.driver.listTabs();
    const target = tabs.find((t) => t.id === tabId);
    if (!target) throw new Error(`Tab ${tabId} not found`);

    if (conversationId) {
      const conv = await chatDb.getConversation(conversationId);
      // Only fold into the group if the conversation already owns one.
      // Creating a group from selectTab alone feels too aggressive — the
      // agent may just be peeking at an existing tab.
      if (conv?.ownedGroupId != null) {
        await ctx.session?.bindActiveTabToConversation?.(tabId);
      }
    }

    await ctx.driver.setActiveTab(tabId);
    return { selected: true, tab };
  },
};
