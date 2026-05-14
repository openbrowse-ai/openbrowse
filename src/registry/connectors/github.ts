import type { ConnectorDefinition, ToolResultLabel } from "./types";
import { parseToolResult } from "./types";

interface GitHubSearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: unknown[];
}

interface GitHubIssuesResult {
  issues: unknown[];
  totalCount: number;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string; endCursor: string };
}

export const definition: ConnectorDefinition = {
  id: "github",
  name: "GitHub",
  icon: { light: "github.svg", dark: "github-dark.svg" },
  description: "Repositories, issues, pull requests, and actions",
  category: "developer-tools",
  url: "https://mcp.github.com/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://docs.github.com/en/copilot/using-github-copilot/using-extensions-to-integrate-external-tools",
  formatLabel(toolName, result): ToolResultLabel | null {
    const parsed = parseToolResult(result);

    switch (toolName) {
      case "search_repositories": {
        const r = parsed as GitHubSearchResult | undefined;
        const count = r?.total_count ?? (Array.isArray(r?.items) ? r.items.length : null);
        return { pending: "Searching repos...", done: count != null ? `Found ${count} repos` : "Searched repos" };
      }
      case "get_file_contents":
        return { pending: "Reading file...", done: "Read file" };
      case "create_issue":
        return { pending: "Creating issue...", done: "Created issue" };
      case "list_issues": {
        const r = parsed as GitHubIssuesResult | undefined;
        const count = r?.totalCount ?? (Array.isArray(r?.issues) ? r.issues.length : null);
        return { pending: "Listing issues...", done: count != null ? `Listed ${count} issues` : "Listed issues" };
      }
      case "create_pull_request":
        return { pending: "Creating PR...", done: "Created PR" };
      case "list_pull_requests": {
        const arr = Array.isArray(parsed) ? parsed : null;
        return { pending: "Listing PRs...", done: arr ? `Listed ${arr.length} PRs` : "Listed PRs" };
      }
      case "get_pull_request_diff":
        return { pending: "Fetching diff...", done: "Fetched diff" };
      case "search_code": {
        const r = parsed as GitHubSearchResult | undefined;
        const count = r?.total_count ?? (Array.isArray(r?.items) ? r.items.length : null);
        return { pending: "Searching code...", done: count != null ? `Found ${count} results` : "Searched code" };
      }
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect GitHub to manage your repositories, track issues, review pull requests, and monitor CI/CD workflows. Search code across your organization, create and update issues, review and merge pull requests, and get notified about workflow runs — all without leaving the conversation.",
    developer: { name: "GitHub", url: "https://github.com" },
    tools: [
      "search_repositories",
      "get_file_contents",
      "create_issue",
      "list_issues",
      "create_pull_request",
      "list_pull_requests",
      "get_pull_request_diff",
      "search_code",
    ],
    links: [
      { label: "Documentation", url: "https://docs.github.com/en/copilot/using-github-copilot/using-extensions-to-integrate-external-tools" },
      { label: "Privacy Policy", url: "https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement" },
    ],
  },
};
