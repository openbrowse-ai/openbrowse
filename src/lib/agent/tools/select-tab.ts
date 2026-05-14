import { z } from "zod";
import { chatDb } from "@/lib/chat-db";
import type { BrowserTool } from "../types";
import { setTargetTabId } from "../active-tab";
import { getAgentContext } from "../agent-transport";
import { resolveHandle } from "../tab-handles";

async function bindActiveTabToConversation(
  conversationId: string,
  tabId: number,
): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: "BIND_ACTIVE_TAB_TO_CONVERSATION",
      conversationId,
      tabId,
    });
  } catch {
    // Background may be asleep; ownership rebuilds on next startup.
  }
}

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
  execute: async ({ tab }) => {
    const { conversationId } = getAgentContext();

    let tabId: number | undefined;
    if (conversationId) {
      tabId = resolveHandle(conversationId, tab);
    }

    // Fallback: try parsing as numeric tab ID for backward compat
    if (tabId == null) {
      const parsed = parseInt(tab, 10);
      if (!isNaN(parsed)) tabId = parsed;
    }

    if (tabId == null) {
      throw new Error(`Tab handle "${tab}" not found. Use listTabs to see available tabs.`);
    }

    const chromeTab = await chrome.tabs.get(tabId);
    if (!chromeTab) throw new Error(`Tab ${tabId} not found`);
    if (chromeTab.url?.startsWith("chrome-extension://") || chromeTab.url?.startsWith("chrome://")) {
      throw new Error("Cannot select extension or chrome:// tabs");
    }

    if (conversationId) {
      const conv = await chatDb.getConversation(conversationId);
      // Only fold into the group if the conversation already owns one.
      // Creating a group from selectTab alone feels too aggressive — the
      // agent may just be peeking at an existing tab.
      if (conv?.ownedGroupId != null) {
        await bindActiveTabToConversation(conversationId, tabId);
      }
    }

    setTargetTabId(tabId);
    return { selected: true, tab };
  },
};
