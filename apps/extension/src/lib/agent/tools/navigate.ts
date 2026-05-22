import { z } from "zod";
import { chatDb } from "@/lib/chat-db";
import { handleForTab } from "../driver";
import { invalidateRefs } from "../ref-store";
import { captureSnapshot } from "../snapshot-capture";
import type { BrowserTool } from "../types";

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
  execute: async ({ url, newTab }, ctx) => {
    const conversationId = ctx.session?.conversationId ?? null;

    let tabId = null as null | ReturnType<typeof ctx.driver.getActiveTabId>;
    let createdNew = false;

    if (!newTab) {
      const currentTarget = ctx.driver.getActiveTabId();
      if (currentTarget != null && conversationId) {
        const conv = await chatDb.getConversation(conversationId);
        const agentOwned = !!conv?.ownedTabIds.includes(Number(currentTarget));
        if (agentOwned) {
          try {
            await ctx.driver.updateTabUrl(currentTarget, url);
            tabId = currentTarget;
          } catch {
            // Tab may have been closed; fall through to create new
          }
        }
      }
    }

    if (tabId == null) {
      tabId = await ctx.driver.createTab(url, { active: false });
      createdNew = true;
    }

    if (createdNew) {
      await ctx.session?.bindTabsToConversation?.([tabId]);
    }

    await ctx.driver.setActiveTab(tabId);
    invalidateRefs(tabId);
    await ctx.driver.waitForLoad(tabId);

    const handle = handleForTab(ctx, tabId);

    // Auto-attach initial snapshot so the agent can act on the new page
    // without a follow-up snapshot call.
    try {
      const { snapshotText, refs } = await captureSnapshot(ctx.driver, tabId);
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
