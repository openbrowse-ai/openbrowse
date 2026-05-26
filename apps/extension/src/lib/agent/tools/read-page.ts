import { z } from "zod";
import type { BrowserTool } from "../types";
import { resolveTabOrThrow } from "../driver";

const parameters = z.object({
  tab: z
    .string()
    .describe(
      "Tab handle to read (e.g. 't1'). See the `## Tabs in this conversation` section of the system prompt, or call listTabs.",
    ),
});

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
  tab: z.string(),
  url: z.string(),
  title: z.string(),
  h1: z.string(),
  description: z.string(),
  bodyText: z.string(),
  links: z.array(z.object({ text: z.string(), href: z.string() })),
});
type Output = z.infer<typeof outputSchema>;

export const readPageTool: BrowserTool<Input, Output> = {
  name: "readPage",
  description:
    "Read the content of a tab. Pass `tab` (handle from the tab legend or listTabs). Returns the URL, title, headings, description, body text (first 10k chars), and up to 50 links.",
  parameters,
  outputSchema,
  execute: async ({ tab: handle }, ctx) => {
    const tab = await resolveTabOrThrow(ctx, handle);
    const url = tab.url ?? "";

    if (url.startsWith("chrome-extension://") || url.startsWith("chrome://")) {
      return {
        tab: handle,
        url,
        title: tab.title ?? "",
        h1: "",
        description: "",
        bodyText: "",
        links: [],
      };
    }

    const result = await ctx.driver.sendToContentScript<Omit<Output, "tab">>(
      tab.id,
      { type: "CHAT_EXTRACT_CONTENT" },
    );
    return { tab: handle, ...result };
  },
};
