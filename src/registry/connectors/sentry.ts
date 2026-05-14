import type { ConnectorDefinition, ToolResultLabel } from "./types";

export const definition: ConnectorDefinition = {
  id: "sentry",
  name: "Sentry",
  icon: { light: "sentry.svg" },
  description: "Error tracking and performance monitoring",
  category: "developer-tools",
  url: "https://mcp.sentry.dev/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://docs.sentry.io/product/integrations/mcp",
  formatLabel(toolName): ToolResultLabel | null {
    switch (toolName) {
      case "search_issues":
        return { pending: "Searching issues...", done: "Searched issues" };
      case "find_projects":
        return { pending: "Finding projects...", done: "Found projects" };
      case "get_issue_details":
        return { pending: "Fetching issue...", done: "Fetched issue" };
      case "get_event":
        return { pending: "Fetching event...", done: "Fetched event" };
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect Sentry to debug issues, resolve errors, and monitor application performance. View recent errors, inspect stack traces, search for issues across projects, and track performance regressions.",
    developer: { name: "Sentry", url: "https://sentry.io" },
    tools: [
      "search_issues",
      "find_projects",
      "get_issue_details",
      "get_event",
    ],
    links: [
      { label: "Documentation", url: "https://docs.sentry.io/product/integrations/mcp" },
      { label: "Privacy Policy", url: "https://sentry.io/privacy/" },
    ],
  },
};
