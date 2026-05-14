import type { ConnectorDefinition, ToolResultLabel } from "./types";
import { parseToolResult } from "./types";

interface SupabaseProjectsResponse {
  projects?: unknown[];
}

export const definition: ConnectorDefinition = {
  id: "supabase",
  name: "Supabase",
  icon: { light: "supabase.svg" },
  description: "Database, auth, storage, and edge functions",
  category: "databases",
  url: "https://mcp.supabase.com/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
  formatLabel(toolName, result): ToolResultLabel | null {
    const parsed = parseToolResult(result);

    switch (toolName) {
      case "list_tables": {
        const arr = Array.isArray(parsed) ? parsed : null;
        return { pending: "Listing tables...", done: arr ? `Listed ${arr.length} tables` : "Listed tables" };
      }
      case "list_migrations": {
        const arr = Array.isArray(parsed) ? parsed : null;
        return { pending: "Listing migrations...", done: arr ? `Listed ${arr.length} migrations` : "Listed migrations" };
      }
      case "list_extensions": {
        const arr = Array.isArray(parsed) ? parsed : null;
        return { pending: "Listing extensions...", done: arr ? `Listed ${arr.length} extensions` : "Listed extensions" };
      }
      case "list_projects": {
        const obj = parsed as SupabaseProjectsResponse | undefined;
        const arr = Array.isArray(parsed) ? parsed : Array.isArray(obj?.projects) ? obj.projects : null;
        return { pending: "Listing projects...", done: arr ? `Listed ${arr.length} projects` : "Listed projects" };
      }
      case "execute_sql":
        return { pending: "Executing SQL...", done: "Executed SQL" };
      case "apply_migration":
        return { pending: "Applying migration...", done: "Applied migration" };
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect Supabase to query your database, manage authentication users, interact with storage buckets, and deploy edge functions. Run SQL queries, inspect table schemas, list migrations, and manage your project infrastructure directly from the conversation.",
    developer: { name: "Supabase", url: "https://supabase.com" },
    tools: [
      "execute_sql",
      "list_tables",
      "list_migrations",
      "apply_migration",
      "list_extensions",
    ],
    links: [
      { label: "Documentation", url: "https://supabase.com/docs/guides/getting-started/mcp" },
      { label: "Support", url: "https://supabase.com/support" },
      { label: "Privacy Policy", url: "https://supabase.com/privacy" },
    ],
  },
};
