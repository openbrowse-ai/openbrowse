/**
 * Connector Registry Types
 *
 * A connector represents an MCP server integration in OpenBrowse.
 * Each connector provides metadata for the UI (name, icon, description),
 * connection details (URL, auth method), and optional result formatting
 * for a polished tool-call experience in the chat.
 */

/** Connector categories shown in the settings browse UI. */
export type ConnectorCategory =
  | "developer-tools"
  | "productivity"
  | "databases"
  | "analytics"
  | "crm";

/**
 * Labels shown in the chat UI while a tool call is in progress
 * and after it completes.
 */
export interface ToolResultLabel {
  /** Shown while the tool is running, e.g. "Listing issues..." */
  pending: string;
  /** Shown after completion, e.g. "Listed 12 issues" */
  done: string;
}

export interface ConnectorDefinition {
  /**
   * Unique identifier. Used as the MCP server ID and to resolve icons.
   * Must be lowercase, alphanumeric + hyphens (e.g. "github", "my-tool").
   */
  id: string;

  /** Human-readable display name (e.g. "GitHub"). */
  name: string;

  /**
   * Icon filenames relative to `src/registry/connectors/icons/`.
   * The `dark` variant is optional — only needed if the light icon
   * doesn't work well on dark backgrounds.
   */
  icon: { light: string; dark?: string };

  /** One-line description shown in the connector browse list. */
  description: string;

  /** Category for grouping in the browse UI. */
  category: ConnectorCategory;

  /** The MCP server endpoint URL. */
  url: string;

  /**
   * Authentication method the server requires.
   * - `"oauth"` — OpenBrowse handles the full OAuth flow (PKCE + dynamic client registration).
   * - `"bearer"` — User provides a static bearer token.
   * - `"api-key"` — User provides an API key (sent as header).
   * - `"none"` — No authentication required.
   */
  auth: { type: "oauth" | "bearer" | "api-key" | "none" };

  /**
   * Set to `true` when the server's OAuth provider does not support RFC 7591
   * dynamic client registration (e.g. Slack). The user must create an OAuth
   * app on the provider's side and paste the client_id (and optionally
   * client_secret) into the connector's auth settings before connecting.
   */
  requiresManualClientId?: boolean;

  /**
   * Optional metadata for rendering the manual client_id setup UI when
   * `requiresManualClientId` is `true`.
   */
  manualClientIdHelp?: {
    /** Link to the provider's app-creation/OAuth-setup docs. */
    setupUrl?: string;
    /** Whether the provider also requires a client_secret (confidential client). */
    needsSecret?: boolean;
    /** Short instruction line shown above the inputs. */
    instructions?: string;
  };

  /** Link to the connector's official MCP documentation. */
  docsUrl?: string;

  /** Extended info shown on the connector detail page. */
  details?: ConnectorDetails;

  /**
   * Customizes the tool-call label shown in chat for this connector's tools.
   *
   * The `result` parameter is the **raw value** from the MCP client — typically
   * a JSON string that needs parsing via `parseToolResult()`. Some servers
   * (like Sentry) return markdown text that cannot be parsed as JSON.
   *
   * Return `null` for tools you don't want to customize (falls back to generic label).
   *
   * @example
   * ```ts
   * formatLabel(toolName, result) {
   *   const parsed = parseToolResult<{ items: unknown[] }>(result);
   *   if (toolName === "list_items") {
   *     const count = parsed?.items?.length;
   *     return { pending: "Listing items...", done: count != null ? `Listed ${count} items` : "Listed items" };
   *   }
   *   return null;
   * }
   * ```
   */
  formatLabel?: (toolName: string, result: unknown) => ToolResultLabel | null;

  /**
   * Custom React renderer for a tool's result in the chat UI.
   *
   * Return a ReactNode to replace the default JSON display when the tool result
   * is expanded. Return `null` to fall back to default rendering.
   *
   * Requires the connector file to use `.tsx` extension.
   *
   * @example
   * ```tsx
   * renderResult(toolName, result) {
   *   if (toolName === "list_issues") {
   *     const parsed = parseToolResult<{ issues: Issue[] }>(result);
   *     return <IssueList issues={parsed?.issues ?? []} />;
   *   }
   *   return null;
   * }
   * ```
   */
  renderResult?: (toolName: string, result: unknown) => import("react").ReactNode;
}

export interface ConnectorDetails {
  /** Multi-sentence description shown on the connector detail/info page. */
  longDescription: string;

  /** The organization that develops/maintains the MCP server. */
  developer: { name: string; url?: string };

  /** Notable tool names this server exposes (shown in the detail UI). */
  tools?: string[];

  /** External links (docs, support, privacy policy). */
  links?: { label: string; url: string }[];
}

/**
 * Parses a raw MCP tool result into a typed object.
 *
 * MCP tool results arrive as JSON strings (the client extracts the `text` field
 * from `{ content: [{ type: "text", text: "..." }] }`). This helper handles
 * the parsing and returns `undefined` if the result is null or unparseable.
 *
 * @example
 * ```ts
 * interface MyResponse { items: string[] }
 * const parsed = parseToolResult<MyResponse>(result);
 * // parsed is MyResponse | undefined
 * ```
 */
export function parseToolResult<T = unknown>(result: unknown): T | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") {
    try {
      return JSON.parse(result) as T;
    } catch {
      return undefined;
    }
  }
  return result as T;
}
