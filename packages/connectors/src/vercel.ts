import type { ConnectorDefinition, ToolResultLabel } from "./types";
import { parseToolResult } from "./types";

interface VercelProjectsResult {
  projects: unknown[];
}

interface VercelDeploymentsResult {
  deployments: {
    pagination: { count: number; next: number | null; prev: number | null };
    deployments: unknown[];
  };
}

export const definition: ConnectorDefinition = {
  id: "vercel",
  name: "Vercel",
  icon: { light: "vercel.svg", dark: "vercel-dark.svg" },
  description: "Deployments, domains, and serverless functions",
  category: "developer-tools",
  url: "https://mcp.vercel.com/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://vercel.com/docs/mcp",
  formatLabel(toolName, result): ToolResultLabel | null {
    const parsed = parseToolResult(result);

    switch (toolName) {
      case "list_projects": {
        const r = parsed as VercelProjectsResult | undefined;
        const count = Array.isArray(r?.projects) ? r.projects.length : null;
        return { pending: "Listing projects...", done: count != null ? `Listed ${count} projects` : "Listed projects" };
      }
      case "get_project":
        return { pending: "Fetching project...", done: "Fetched project" };
      case "list_deployments": {
        const r = parsed as VercelDeploymentsResult | undefined;
        const arr = r?.deployments?.deployments;
        const count = Array.isArray(arr) ? arr.length : null;
        return { pending: "Listing deployments...", done: count != null ? `Listed ${count} deployments` : "Listed deployments" };
      }
      case "get_deployment":
        return { pending: "Fetching deployment...", done: "Fetched deployment" };
      case "get_deployment_build_logs":
        return { pending: "Fetching build logs...", done: "Fetched build logs" };
      case "get_runtime_logs":
        return { pending: "Fetching runtime logs...", done: "Fetched runtime logs" };
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect Vercel to manage deployments, check build logs, inspect runtime errors, and monitor your projects. List projects, view deployment status, read build and runtime logs, and manage environment variables.",
    developer: { name: "Vercel", url: "https://vercel.com" },
    tools: [
      "list_projects",
      "get_project",
      "list_deployments",
      "get_deployment",
      "get_deployment_build_logs",
      "get_runtime_logs",
    ],
    links: [
      { label: "Documentation", url: "https://vercel.com/docs/mcp" },
      { label: "Privacy Policy", url: "https://vercel.com/legal/privacy-policy" },
    ],
  },
};
