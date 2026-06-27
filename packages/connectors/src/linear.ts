import type { ConnectorDefinition, ToolResultLabel } from "./types";
import { parseToolResult } from "./types";

interface LinearListResponse {
  issues?: unknown[];
  projects?: unknown[];
  teams?: unknown[];
}

export const definition: ConnectorDefinition = {
  id: "linear",
  name: "Linear",
  icon: { light: "linear.svg" },
  description: "Project management and issue tracking",
  category: "developer-tools",
  url: "https://mcp.linear.app/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://linear.app/docs/mcp",
  formatLabel(toolName, result): ToolResultLabel | null {
    const parsed = parseToolResult<LinearListResponse>(result);

    switch (toolName) {
      case "list_issues": {
        const count = Array.isArray(parsed?.issues) ? parsed.issues.length : null;
        return { pending: "Listing issues...", done: count != null ? `Listed ${count} issues` : "Listed issues" };
      }
      case "get_issue":
        return { pending: "Fetching issue...", done: "Fetched issue" };
      case "save_issue":
        return { pending: "Saving issue...", done: "Saved issue" };
      case "list_projects": {
        const count = Array.isArray(parsed?.projects) ? parsed.projects.length : null;
        return { pending: "Listing projects...", done: count != null ? `Listed ${count} projects` : "Listed projects" };
      }
      case "get_project":
        return { pending: "Fetching project...", done: "Fetched project" };
      case "list_teams": {
        const count = Array.isArray(parsed?.teams) ? parsed.teams.length : null;
        return { pending: "Listing teams...", done: count != null ? `Listed ${count} teams` : "Listed teams" };
      }
      case "search_documentation":
        return { pending: "Searching docs...", done: "Searched docs" };
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect Linear to manage issues, projects, and cycles. Create and update issues, track project progress, search across your workspace, and coordinate with your team — all through natural conversation.",
    developer: { name: "Linear", url: "https://linear.app" },
    tools: [
      "list_issues",
      "get_issue",
      "save_issue",
      "list_projects",
      "get_project",
      "list_teams",
      "search_documentation",
    ],
    links: [
      { label: "Documentation", url: "https://linear.app/docs/mcp" },
      { label: "Privacy Policy", url: "https://linear.app/privacy" },
    ],
  },
};
