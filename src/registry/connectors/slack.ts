import type { ConnectorDefinition, ToolResultLabel } from "./types";
import { parseToolResult } from "./types";

interface SlackSearchResponse {
  messages?: { matches?: unknown[] };
  channels?: unknown[];
}

export const definition: ConnectorDefinition = {
  id: "slack",
  name: "Slack",
  icon: { light: "slack.svg" },
  description: "Messaging, channels, and canvases",
  category: "productivity",
  url: "https://mcp.slack.com/mcp",
  auth: { type: "oauth" },
  requiresManualClientId: true,
  manualClientIdHelp: {
    setupUrl: "https://api.slack.com/apps",
    needsSecret: true,
    instructions:
      "Slack requires a pre-registered OAuth app. Create one at api.slack.com/apps, add OpenBrowse's redirect URL, then paste the Client ID and Client Secret here.",
  },
  docsUrl: "https://api.slack.com/docs/mcp",
  formatLabel(toolName, result): ToolResultLabel | null {
    const parsed = parseToolResult<SlackSearchResponse>(result);

    switch (toolName) {
      case "slack_read_channel":
        return { pending: "Reading channel...", done: "Read channel" };
      case "slack_read_thread":
        return { pending: "Reading thread...", done: "Read thread" };
      case "slack_send_message":
        return { pending: "Sending message...", done: "Sent message" };
      case "slack_search_public":
      case "slack_search_public_and_private": {
        const count = Array.isArray(parsed?.messages?.matches) ? parsed.messages.matches.length : null;
        return { pending: "Searching messages...", done: count != null ? `Found ${count} messages` : "Searched messages" };
      }
      case "slack_search_channels": {
        const count = Array.isArray(parsed?.channels) ? parsed.channels.length : null;
        return { pending: "Searching channels...", done: count != null ? `Found ${count} channels` : "Searched channels" };
      }
      case "slack_create_canvas":
        return { pending: "Creating canvas...", done: "Created canvas" };
      default:
        return null;
    }
  },
  details: {
    longDescription:
      "Connect Slack to read channels, send messages, search conversations, and manage canvases. Draft replies, summarize threads, find information across your workspace, and schedule messages for later.",
    developer: { name: "Slack", url: "https://slack.com" },
    tools: [
      "slack_read_channel",
      "slack_read_thread",
      "slack_send_message",
      "slack_search_public",
      "slack_search_channels",
      "slack_create_canvas",
    ],
    links: [
      { label: "Documentation", url: "https://api.slack.com/docs/mcp" },
      { label: "Privacy Policy", url: "https://slack.com/privacy-policy" },
    ],
  },
};
