import type { ConnectorDefinition, ToolResultLabel } from "./types";

export const definition: ConnectorDefinition = {
  id: "attio",
  name: "Attio",
  icon: { light: "attio.svg", dark: "attio-dark.svg" },
  description: "CRM records, notes, tasks, and pipeline",
  category: "crm",
  url: "https://mcp.attio.com/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://docs.attio.com/mcp/overview",
  formatLabel(toolName): ToolResultLabel | null {
    // Static labels for v1. Attio's MCP server is closed-source, so we
    // don't have a verified JSON schema for the tool results — count
    // extraction would need to be added in a follow-up after observing
    // live response shapes (see Sentry for the same approach).
    switch (toolName) {
      case "search-records":
        return { pending: "Searching records...", done: "Searched records" };
      case "list-records":
        return { pending: "Listing records...", done: "Listed records" };
      case "get-records-by-ids":
        return { pending: "Fetching records...", done: "Fetched records" };
      case "create-record":
        return { pending: "Creating record...", done: "Created record" };
      case "upsert-record":
        return { pending: "Upserting record...", done: "Upserted record" };
      case "update-record":
        return { pending: "Updating record...", done: "Updated record" };
      case "list-attribute-definitions":
        return { pending: "Listing attributes...", done: "Listed attributes" };
      case "list-lists":
        return { pending: "Listing lists...", done: "Listed lists" };
      case "list-list-attribute-definitions":
        return { pending: "Listing list attributes...", done: "Listed list attributes" };
      case "list-records-in-list":
        return { pending: "Listing list entries...", done: "Listed list entries" };
      case "add-record-to-list":
        return { pending: "Adding to list...", done: "Added to list" };
      case "update-list":
        return { pending: "Updating list...", done: "Updated list" };
      case "update-list-entry-by-id":
      case "update-list-entry-by-record-id":
        return { pending: "Updating list entry...", done: "Updated list entry" };
      case "create-comment":
        return { pending: "Posting comment...", done: "Posted comment" };
      case "list-comments":
        return { pending: "Listing comments...", done: "Listed comments" };
      case "list-comment-replies":
        return { pending: "Loading replies...", done: "Loaded replies" };
      case "delete-comment":
        return { pending: "Deleting comment...", done: "Deleted comment" };
      case "create-note":
        return { pending: "Creating note...", done: "Created note" };
      case "search-notes-by-metadata":
      case "semantic-search-notes":
        return { pending: "Searching notes...", done: "Searched notes" };
      case "get-note-body":
        return { pending: "Fetching note...", done: "Fetched note" };
      case "update-note":
        return { pending: "Updating note...", done: "Updated note" };
      case "list-tasks":
        return { pending: "Listing tasks...", done: "Listed tasks" };
      case "create-task":
        return { pending: "Creating task...", done: "Created task" };
      case "update-task":
        return { pending: "Updating task...", done: "Updated task" };
      case "search-meetings":
        return { pending: "Searching meetings...", done: "Searched meetings" };
      case "search-call-recordings-by-metadata":
      case "semantic-search-call-recordings":
        return { pending: "Searching calls...", done: "Searched calls" };
      case "get-call-recording":
        return { pending: "Fetching call...", done: "Fetched call" };
      case "search-emails-by-metadata":
      case "semantic-search-emails":
        return { pending: "Searching emails...", done: "Searched emails" };
      case "get-email-content":
        return { pending: "Fetching email...", done: "Fetched email" };
      case "list-workspace-members":
        return { pending: "Listing members...", done: "Listed members" };
      case "list-workspace-teams":
        return { pending: "Listing teams...", done: "Listed teams" };
      case "whoami":
        return { pending: "Identifying...", done: "Identified" };
      case "run-basic-report":
        return { pending: "Running report...", done: "Ran report" };
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect Attio to manage your CRM through conversation. Search and update people, companies, and deals; log notes from calls; create follow-up tasks; query lists and pipelines; and run reports across your workspace.",
    developer: { name: "Attio", url: "https://attio.com" },
    tools: [
      // Records & Objects
      "search-records",
      "list-records",
      "get-records-by-ids",
      "create-record",
      "upsert-record",
      "update-record",
      "list-attribute-definitions",
      // Lists
      "list-lists",
      "list-list-attribute-definitions",
      "list-records-in-list",
      "add-record-to-list",
      "update-list",
      "update-list-entry-by-id",
      "update-list-entry-by-record-id",
      // Comments
      "create-comment",
      "list-comments",
      "list-comment-replies",
      "delete-comment",
      // Notes
      "create-note",
      "search-notes-by-metadata",
      "semantic-search-notes",
      "get-note-body",
      "update-note",
      // Tasks
      "list-tasks",
      "create-task",
      "update-task",
      // Meetings & Calls
      "search-meetings",
      "search-call-recordings-by-metadata",
      "semantic-search-call-recordings",
      "get-call-recording",
      // Emails
      "search-emails-by-metadata",
      "semantic-search-emails",
      "get-email-content",
      // Workspace
      "list-workspace-members",
      "list-workspace-teams",
      "whoami",
      // Reporting
      "run-basic-report",
    ],
    links: [
      { label: "Documentation", url: "https://docs.attio.com/mcp/overview" },
      { label: "Privacy Policy", url: "https://attio.com/legal/privacy-policy" },
    ],
  },
};
