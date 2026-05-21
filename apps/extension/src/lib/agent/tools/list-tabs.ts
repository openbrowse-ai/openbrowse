import { z } from "zod";
import type { BrowserTool } from "../types";
import { getAgentContext } from "../agent-transport";
import { getOrCreateHandle } from "../tab-handles";

const parameters = z.object({});

type Input = z.infer<typeof parameters>;

type Output = { tab: string; url: string; title: string; active: boolean }[];

export const listTabsTool: BrowserTool<Input, Output> = {
  name: "listTabs",
  description:
    "List all open browsing tabs in the current window (excludes extension pages). Returns each tab's handle (t1, t2, ...), URL, title, and whether it is active. Use handles with selectTab.",
  parameters,
  execute: async () => {
    const currentWindow = await chrome.windows.getCurrent();
    if (!currentWindow.id) throw new Error("No current window");

    const result = await chrome.runtime.sendMessage({
      type: "CHAT_LIST_TABS",
      windowId: currentWindow.id,
    });

    if (!result.success)
      throw new Error(result.error ?? "Failed to list tabs");

    const { conversationId } = getAgentContext();

    return (result.data as { id: number; url: string; title: string; active: boolean }[])
      .filter((t) => !t.url.startsWith("chrome-extension://") && !t.url.startsWith("chrome://"))
      .map((t) => ({
        tab: conversationId ? getOrCreateHandle(conversationId, t.id) : `t${t.id}`,
        url: t.url,
        title: t.title,
        active: t.active,
      }));
  },
};
