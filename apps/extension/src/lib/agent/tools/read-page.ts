import { z } from "zod";
import { getActiveUserTab, sendToContentScript } from "../active-tab";
import type { BrowserTool } from "../types";

const parameters = z.object({});

type Input = z.infer<typeof parameters>;

type Output = {
  url: string;
  title: string;
  h1: string;
  description: string;
  bodyText: string;
  links: { text: string; href: string }[];
};

export const readPageTool: BrowserTool<Input, Output> = {
  name: "readPage",
  description:
    "Read the content of the user's active browsing tab. Returns the page URL, title, headings, description, body text (first 10k chars), and up to 50 links.",
  parameters,
  execute: async () => {
    const tab = await getActiveUserTab();
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

    return await sendToContentScript<Output>(tab.id!, {
      type: "CHAT_EXTRACT_CONTENT",
    });
  },
};
