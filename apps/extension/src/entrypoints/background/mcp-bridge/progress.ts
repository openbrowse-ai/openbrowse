/**
 * Pure helpers that turn raw `step-start` event data into the
 * user-visible progress strings displayed on a running task's
 * Activity card.
 *
 * Two outputs:
 *   - `lastEvent`: a short human-readable summary of what the agent
 *     is doing right now, e.g. "Navigating to example.com",
 *     "Reading page", "Clicking 'Submit'".
 *   - `currentUrl`: the URL the agent is operating on (when the tool
 *     name is a navigate-shaped tool and the args carry a URL).
 *
 * Designed to be pure + test-friendly: callers feed in `toolName` and
 * a possibly-empty `argsPreview` (JSON-stringified or raw); we parse
 * defensively. argsPreview may be truncated by the runner (head +
 * ellipsis + tail); we still attempt extraction but fall back
 * gracefully when JSON parse fails.
 */

/** Reasonable per-tool labels mapped from the SDK tool name. */
const TOOL_LABELS: Record<string, string> = {
  navigate: "Navigating",
  open_url: "Opening URL",
  read_page: "Reading page",
  readPage: "Reading page",
  screenshot: "Taking screenshot",
  selectTab: "Switching tab",
  listTabs: "Listing tabs",
  clickElement: "Clicking",
  typeInElement: "Typing",
  pressKey: "Pressing key",
  scrollPage: "Scrolling page",
  closeTabs: "Closing tabs",
  delegate: "Delegating to subagent",
  executeOnPage: "Running script on page",
  executePython: "Running Python",
  executeCode: "Running code",
  extract: "Extracting from page",
  todoWrite: "Updating todo list",
  searchMemory: "Searching memory",
  createArtifact: "Creating artifact",
  updateArtifact: "Updating artifact",
  deleteArtifact: "Deleting artifact",
  listArtifacts: "Listing artifacts",
  readArtifactDiagnostics: "Checking artifact diagnostics",
  Write: "Writing file",
  Edit: "Editing file",
  Delete: "Deleting file",
  Move: "Moving file",
  skill: "Loading skill",
  install_skill: "Installing skill",
  create_skill: "Creating skill",
  proposePlan: "Proposing plan",
  patchSiteSkill: "Patching site skill",
  deleteSiteSkill: "Deleting site skill",
  snapshot: "Taking AX snapshot",
  read_network_requests: "Reading network requests",
  read_console_messages: "Reading console messages",
  create_scheduled_task: "Scheduling task",
  list_scheduled_tasks: "Listing scheduled tasks",
  update_scheduled_task: "Updating scheduled task",
};

/**
 * Best-effort JSON parse. Returns the parsed object on success, or
 * undefined for any other input (truncated string, bare string,
 * malformed JSON, etc.).
 */
function tryParseJson(s: string | undefined): Record<string, unknown> | undefined {
  if (s === undefined || s.length === 0) return undefined;
  try {
    const parsed = JSON.parse(s);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a URL string from parsed args. Recognised shapes:
 *   - `{ url: "..." }`
 *   - `{ targetUrl: "..." }`
 *   - `{ href: "..." }`
 *   - `{ tab: { url: "..." } }` (selectTab-style)
 * Returns the URL or null.
 */
function extractUrl(args: Record<string, unknown>): string | null {
  const candidates: string[] = [];
  for (const key of ["url", "targetUrl", "href"] as const) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) candidates.push(v);
  }
  const tab = args["tab"];
  if (tab != null && typeof tab === "object" && !Array.isArray(tab)) {
    const tabUrl = (tab as Record<string, unknown>)["url"];
    if (typeof tabUrl === "string" && tabUrl.length > 0) candidates.push(tabUrl);
  }
  // Only return a URL that parses — otherwise the UI would render
  // garbage from a malformed args payload.
  for (const raw of candidates) {
    if (hostnameOf(raw) != null) return raw;
  }
  return null;
}

/**
 * Short args-derived hint for the lastEvent line. Examples:
 *   - navigate { url: "https://example.com" } → "to example.com"
 *   - clickElement { target: "@e3" } → "‘@e3’"
 *   - typeInElement { target: "@e5", text: "hello" } → "‘hello’"
 *   - Write { file_path: "/foo/bar.ts" } → "/foo/bar.ts"
 * Returns "" when no useful hint can be extracted.
 */
function buildArgsHint(toolName: string, args: Record<string, unknown>): string {
  // URL-bearing tools: append the domain.
  const url = extractUrl(args);
  if (url) {
    const host = hostnameOf(url);
    if (host) return `to ${host}`;
  }

  // Element-targeting tools: append the selector/text in quotes.
  // clickElement/typeInElement/pressKey all use `target` for the
  // element handle; typeInElement additionally has `text`. We prefer
  // the human-readable text (what the user typed) over the opaque
  // @ref/selector when both are available.
  if (toolName === "clickElement" || toolName === "typeInElement") {
    const text = args["text"];
    if (typeof text === "string" && text.length > 0) {
      return `‘${truncate(text, 24)}’`;
    }
    const target = args["target"] ?? args["selector"] ?? args["selectorOrText"];
    if (typeof target === "string" && target.length > 0) {
      return `‘${truncate(target, 24)}’`;
    }
  }

  if (toolName === "pressKey") {
    const key = args["key"];
    if (typeof key === "string" && key.length > 0) {
      return `‘${key}’`;
    }
  }

  if (toolName === "delegate") {
    const slug = args["slug"];
    if (typeof slug === "string" && slug.length > 0) {
      return `‘${truncate(slug, 24)}’`;
    }
  }

  // Write/Edit take `file_path`; Delete takes `path`. Accept either
  // shape defensively so future SDK renames don't silently break the
  // hint.
  if (toolName === "Write" || toolName === "Edit" || toolName === "Delete") {
    const path = args["file_path"] ?? args["path"];
    if (typeof path === "string" && path.length > 0) {
      return truncate(path, 40);
    }
  }

  // Move takes `from_path`/`to_path`; show the destination.
  if (toolName === "Move") {
    const to = args["to_path"] ?? args["from_path"];
    if (typeof to === "string" && to.length > 0) {
      return truncate(to, 40);
    }
  }

  return "";
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Map a tool name to its human-readable verb. Falls back to the raw
 * tool name when there's no mapping (forward-compatible with future
 * SDK tools without code change).
 */
export function toolNameToLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

/**
 * Build the user-facing progress strings for a `step-start` event.
 * Returns `lastEvent` (always set) and `currentUrl` (when present in
 * args). Pure: takes the minimal inputs and is fully unit-testable.
 */
export function progressFromStepStart(input: {
  toolName: string;
  argsPreview: string;
}): { lastEvent: string; currentUrl: string | null } {
  const label = toolNameToLabel(input.toolName);
  const args = tryParseJson(input.argsPreview);
  if (args == null) {
    return { lastEvent: label, currentUrl: null };
  }
  const hint = buildArgsHint(input.toolName, args);
  const url = extractUrl(args);
  return {
    lastEvent: hint ? `${label} ${hint}` : label,
    currentUrl: url,
  };
}

/** Build the lastEvent string for a `step-finish` event. */
export function progressFromStepFinish(input: {
  toolName: string;
}): { lastEvent: string } {
  const label = toolNameToLabel(input.toolName);
  return { lastEvent: `${label} — done` };
}
