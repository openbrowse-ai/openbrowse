import { z } from "zod";
import type { BrowserTool } from "../types";
import { handleForTab } from "../driver";

const parameters = z.object({});

type Input = z.infer<typeof parameters>;

type Output = { tab: string; url: string; title: string; active: boolean }[];

export const listTabsTool: BrowserTool<Input, Output> = {
  name: "listTabs",
  description:
    "List all open browsing tabs in the current window (excludes extension pages). Returns each tab's handle (t1, t2, ...), URL, title, and whether it is active. Use handles with selectTab.",
  parameters,
  execute: async (_input, ctx) => {
    const tabs = await ctx.driver.listTabs();
    return tabs.map((t) => ({
      tab: handleForTab(ctx, t.id),
      url: t.url,
      title: t.title,
      active: !!t.active,
    }));
  },
};
