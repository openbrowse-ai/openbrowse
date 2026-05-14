# Connector Registry

The connector registry defines MCP (Model Context Protocol) server integrations available in OpenBrowse. Each connector provides the metadata, authentication config, and optional result formatting needed to give users a polished experience when interacting with external tools.

## Adding a new connector

### 1. Create the definition file

Create `src/registry/connectors/{id}.ts`:

```ts
import type { ConnectorDefinition, ToolResultLabel } from "./types";
import { parseToolResult } from "./types";

// Type the response shapes you expect from the MCP server.
// Verify these against the server's source code — don't guess.
interface MyToolListResponse {
  items: { id: string; name: string }[];
  total_count: number;
}

export const definition: ConnectorDefinition = {
  id: "my-tool",
  name: "My Tool",
  icon: { light: "my-tool.svg" },
  description: "One-line summary of what this connector does",
  category: "developer-tools",
  url: "https://mcp.my-tool.com/mcp",
  auth: { type: "oauth" },
  docsUrl: "https://docs.my-tool.com/mcp",
  formatResult(toolName, result): ToolResultLabel | null {
    const parsed = parseToolResult<MyToolListResponse>(result);

    switch (toolName) {
      case "list_items": {
        const count = parsed?.total_count ?? (Array.isArray(parsed?.items) ? parsed.items.length : null);
        return { pending: "Listing items...", done: count != null ? `Listed ${count} items` : "Listed items" };
      }
      case "get_item":
        return { pending: "Fetching item...", done: "Fetched item" };
      default:
        return null;
    }
  },
  details: {
    longDescription: "A longer description shown on the connector detail page...",
    developer: { name: "My Tool Inc.", url: "https://my-tool.com" },
    tools: ["list_items", "get_item", "create_item"],
    links: [
      { label: "Documentation", url: "https://docs.my-tool.com/mcp" },
      { label: "Privacy Policy", url: "https://my-tool.com/privacy" },
    ],
  },
};
```

### 2. Add an icon

Place your SVG icon at `src/registry/connectors/icons/{id}.svg`.

- Must be a square SVG (ideally 16×16 or 24×24 viewBox)
- Keep it simple — it renders at 14–16px in the chat UI
- For dark mode, add a `{id}-dark.svg` and set `icon: { light: "{id}.svg", dark: "{id}-dark.svg" }`

Then register it in `src/components/ui/registry-icon.tsx`:

```ts
import myToolSvg from "@/registry/connectors/icons/my-tool.svg?raw";
// optionally: import myToolDarkSvg from "@/registry/connectors/icons/my-tool-dark.svg?raw";

// Add to the icons record:
"my-tool": { light: myToolSvg },
```

### 3. Register the connector

In `src/registry/connectors/index.ts`:

```ts
import { definition as myTool } from "./my-tool";

export const connectors: ConnectorDefinition[] = [
  // ... existing connectors
  myTool,
];
```

### 4. Verify TypeScript compiles

```sh
npx tsc --noEmit
```

## Customizing tool call UI with `formatResult`

Without `formatResult`, the chat UI shows generic labels like `"Running list_customers..."`. With it, you control what users see — both during execution and after completion.

### How it works

```
MCP Server → { content: [{ type: "text", text: "<JSON string>" }] }
           → client.ts extracts the text field
           → formatResult receives it as a raw string
           → you return { pending, done } labels for the UI
```

Return `null` for any tool you don't want to customize — it falls back to the generic label.

### Examples

**Extracting counts from structured JSON:**

```ts
formatResult(toolName, result): ToolResultLabel | null {
  const parsed = parseToolResult<{ data: unknown[] }>(result);
  if (toolName === "list_customers") {
    const count = Array.isArray(parsed?.data) ? parsed.data.length : null;
    return { pending: "Listing customers...", done: count != null ? `Listed ${count} customers` : "Listed customers" };
  }
  return null;
}
```

**Pulling meaningful info from the result (not just counts):**

```ts
formatResult(toolName, result): ToolResultLabel | null {
  const parsed = parseToolResult<{ name: string; status: string }>(result);
  switch (toolName) {
    case "get_deployment":
      return { pending: "Fetching deployment...", done: parsed?.name ? `Fetched ${parsed.name} (${parsed.status})` : "Fetched deployment" };
    case "send_message":
      return { pending: "Sending message...", done: "Sent message" };
    default:
      return null;
  }
}
```

**Static labels (when the result is unstructured text or you just want clean verbs):**

```ts
formatResult(toolName): ToolResultLabel | null {
  switch (toolName) {
    case "search_issues":
      return { pending: "Searching issues...", done: "Searched issues" };
    case "apply_migration":
      return { pending: "Applying migration...", done: "Applied migration" };
    default:
      return null;
  }
}
```

### Verify response shapes

The JSON payload inside tool results is server-specific. Always check the server's source code before writing types:

| Server | Example shape |
|--------|--------------|
| GitHub | `{ issues: [...], totalCount: 42, pageInfo: {...} }` |
| Stripe | `{ object: "list", data: [...], has_more: true }` |
| Vercel | `{ deployments: { deployments: [...], pagination: {...} } }` |
| Sentry | Plain markdown text (not JSON) |
| Linear | `{ issues: [...] }` |

## File structure

```
src/registry/connectors/
├── README.md           ← you are here
├── types.ts            ← ConnectorDefinition, parseToolResult, etc.
├── index.ts            ← registry array + lookup functions
├── icons/              ← SVG icons ({id}.svg, optional {id}-dark.svg)
│   ├── github.svg
│   ├── github-dark.svg
│   └── ...
├── github.ts           ← one file per connector
├── linear.ts
├── notion.ts
├── sentry.ts
├── slack.ts
├── stripe.ts
├── supabase.ts
└── vercel.ts
```

## Guidelines

- **One file per connector** — keeps diffs clean and ownership clear.
- **Type your response shapes** — define interfaces for what the MCP server actually returns. Don't use `Record<string, unknown>` or `any`.
- **Use `parseToolResult<T>()`** — it handles the JSON string → object parsing that all MCP results need.
- **Make labels informative** — pull out whatever is useful: counts, names, statuses. If the server gives a `total_count` field, prefer it over `.length`.
- **Return `null` for unhandled tools** — the UI falls back to a generic `"Running {tool_name}..."` label.
- **Verify against source** — The JSON payload inside tool results is server-specific. Find the server's repo and check the actual handler implementation before writing types.
