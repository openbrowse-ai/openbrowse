import { z } from "zod";
import { chatDb } from "@/lib/chat-db";
import { getTargetTabId, setTargetTabId, waitForTabLoad } from "../active-tab";
import { getAgentContext } from "../agent-transport";
import { invalidateRefs } from "../ref-store";
import { captureSnapshot } from "../snapshot-capture";
import { getOrCreateHandle } from "../tab-handles";
import type { BrowserTool } from "../types";

async function bindTabsToConversation(
  conversationId: string,
  tabIds: number[],
): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: "BIND_TABS_TO_CONVERSATION",
      conversationId,
      tabIds,
    });
  } catch {
    // Background may be asleep or message dropped; ownership will be
    // reconstructed on next startup via rebuildIndexesFromStorage.
  }
}

const parameters = z.object({
  url: z.string().describe("The URL to navigate to"),
  newTab: z
    .boolean()
    .optional()
    .describe(
      "Force opening a new tab instead of reusing the current one. Useful when you want to keep the current page open for comparison.",
    ),
});

type Input = z.infer<typeof parameters>;

type Output = {
  navigated: true;
  url: string;
  tab: string;
  snapshot?: string;
  refCount?: number;
  note?: string;
};

export const navigateTool: BrowserTool<Input, Output> = {
  name: "navigate",
  description:
    "Navigate to a URL. Reuses the current agent-owned tab if one exists, otherwise opens a new background tab. Pass newTab: true to force a new tab. The response automatically includes a snapshot of the landed page so you can interact immediately.",
  parameters,
  execute: async ({ url, newTab }) => {
    const { conversationId } = getAgentContext();

    let tabId: number | null = null;
    let createdNew = false;

    if (!newTab) {
      const currentTarget = getTargetTabId();
      if (currentTarget && conversationId) {
        const conv = await chatDb.getConversation(conversationId);
        const agentOwned = !!conv?.ownedTabIds.includes(currentTarget);
        if (agentOwned) {
          try {
            await chrome.tabs.update(currentTarget, { url });
            tabId = currentTarget;
          } catch {
            // Tab may have been closed; fall through to create new
          }
        }
      }
    }

    if (tabId === null) {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id!;
      createdNew = true;
    }

    if (conversationId && createdNew) {
      await bindTabsToConversation(conversationId, [tabId]);
    }

    setTargetTabId(tabId);
    invalidateRefs(tabId);
    await waitForTabLoad(tabId);

    const handle = conversationId
      ? getOrCreateHandle(conversationId, tabId)
      : `t${tabId}`;

    // Auto-attach initial snapshot so the agent can act on the new page
    // without a follow-up snapshot call.
    try {
      const { snapshotText, refs } = await captureSnapshot(tabId);
      return {
        navigated: true,
        url,
        tab: handle,
        snapshot: snapshotText,
        refCount: refs.size,
      };
    } catch (err) {
      return {
        navigated: true,
        url,
        tab: handle,
        note: `Navigation succeeded but initial snapshot failed: ${
          err instanceof Error ? err.message : String(err)
        }. Call snapshot to retry.`,
      };
    }
  },
};
