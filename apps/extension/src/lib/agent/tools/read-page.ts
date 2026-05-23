import { z } from "zod";
import type { BrowserTool } from "../types";

const parameters = z.object({});

type Input = z.infer<typeof parameters>;

const outputSchema = z.object({
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
    "Read the content of the user's active browsing tab. Returns the page URL, title, headings, description, body text (first 10k chars), and up to 50 links.",
  parameters,
  outputSchema,
  execute: async (_input, ctx) => {
    const tab = await ctx.driver.getActiveTab();
    const url = tab.url ?? "";

    if (url.startsWith("chrome-extension://") || url.startsWith("chrome://")) {
      return {
        url,
        title: tab.title ?? "",
        h1: "",
        description: "",
        bodyText: "",
        links: [],
      };
    }

    return await ctx.driver.sendToContentScript<Output>(tab.id, {
      type: "CHAT_EXTRACT_CONTENT",
    });
  },
};
