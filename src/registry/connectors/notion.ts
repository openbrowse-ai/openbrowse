import type { ConnectorDefinition, ToolResultLabel } from "./types";
import { parseToolResult } from "./types";

interface NotionListResponse {
  results?: unknown[];
}

export const definition: ConnectorDefinition = {
  id: "notion",
  name: "Notion",
  icon: { light: "notion.svg", dark: "notion-dark.svg" },
  description: "Pages, databases, and workspace content",
  category: "productivity",
  url: "https://mcp.notion.so/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://developers.notion.com",
  formatLabel(toolName, result): ToolResultLabel | null {
    const parsed = parseToolResult<NotionListResponse>(result);

    switch (toolName) {
      case "notion-search": {
        const count = Array.isArray(parsed?.results)
          ? parsed.results.length
          : null;
        return {
          pending: "Searching...",
          done: count != null ? `Found ${count} results` : "Searched",
        };
      }
      case "notion-fetch":
        return { pending: "Fetching page...", done: "Fetched page" };
      case "notion-create-pages":
        return { pending: "Creating page...", done: "Created page" };
      case "notion-update-page":
        return { pending: "Updating page...", done: "Updated page" };
      case "notion-query-database-view": {
        const count = Array.isArray(parsed?.results)
          ? parsed.results.length
          : null;
        return {
          pending: "Querying database...",
          done: count != null ? `Queried ${count} rows` : "Queried database",
        };
      }
      case "notion-create-database":
        return { pending: "Creating database...", done: "Created database" };
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect Notion to search your workspace, read and create pages, query databases, and manage content. Find project notes, extract data from databases, update documentation, and organize information across your Notion workspace.",
    developer: { name: "Notion", url: "https://notion.so" },
    tools: [
      "notion-search",
      "notion-fetch",
      "notion-create-pages",
      "notion-update-page",
      "notion-query-database-view",
      "notion-create-database",
    ],
    links: [
      { label: "Documentation", url: "https://developers.notion.com" },
      { label: "Privacy Policy", url: "https://www.notion.so/privacy" },
    ],
  },
};
