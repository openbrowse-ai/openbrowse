export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export const ALL_TOOLS = [
  {
    name: "get_context",
    description: "Returns the current focused window and a summary of all open windows.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_windows",
    description:
      "Lists all Chrome windows OpenBrowse can see, with active tab info and optional space binding.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_spaces",
    description:
      "Lists user-created Spaces (project containers). Returns empty array for users without spaces.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_page",
    description:
      "Reads page content (snapshot, text, or html) from a specific tab or the focused window's active tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Chrome tab id; omit for active tab in focused window" },
        format: { type: "string", enum: ["snapshot", "text", "html"], default: "snapshot" },
        scopeSelector: { type: "string", description: "CSS selector to scope a snapshot" },
      },
    },
  },
  {
    name: "screenshot",
    description:
      "Captures a PNG screenshot of a tab. Returns an MCP resource URL (artifact://<id>) the host can fetch.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number", description: "Chrome tab id; omit for active tab in focused window" },
        fullPage: { type: "boolean", default: false, description: "Capture full scrollable page, not just viewport" },
      },
    },
  },
  {
    name: "open_url",
    description:
      "Opens a URL in a new tab in the focused window (or a specified window). Returns the new tabId. Does NOT navigate the user's existing tabs.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL to open" },
        windowId: { type: "number", description: "Target window id (default: focused window)" },
        active: { type: "boolean", default: false, description: "Make the new tab active" },
      },
      required: ["url"],
    },
  },
  {
    name: "task",
    description:
      "Dispatches an autonomous agent run inside the user's Chrome and returns IMMEDIATELY with a task handle: `{ taskId, status, startedAt }` within ~1 second. To get the final output, call `task_wait` next — that call blocks until the task completes (default 5 minutes, configurable up to 15). May require user consent: when consent is needed the returned status is `awaiting_confirmation` and `task_wait` will continue blocking until the user decides.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Plain-language task description for the agent" },
        space: { type: "string", description: "Optional Space name to scope the task into (uses the Space's instructions and bound window)" },
        windowId: { type: "number", description: "Optional explicit Chrome window id (overrides Space resolution)" },
        confirmation: {
          type: "string",
          enum: ["auto", "prompt"],
          description: "Host's request for confirmation behaviour. 'prompt' asks the user before each task; 'auto' lets the user's per-host policy decide. User's policy always wins if it is more restrictive.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "task_wait",
    description:
      "Blocks until the given task reaches a terminal status (`completed`, `errored`, or `cancelled`) and returns the full result including `output` (if completed) or `error` (if failed). This is the call you should make after `task` to wait for the answer — it is a single blocking call, NOT a polling loop. Default timeout is 5 minutes; pass `timeoutMs` (up to 900_000 = 15 minutes) for longer tasks. If the timeout elapses while the task is still running, returns the latest non-terminal status — call `task_wait` again with the same `taskId` to keep waiting.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The taskId returned by the prior `task` call" },
        timeoutMs: {
          type: "number",
          description: "Max ms to block before returning the current non-terminal status. Default 300000 (5 min). Hard cap 900000 (15 min).",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "task_status",
    description:
      "Returns a snapshot of a task's current state IMMEDIATELY (no blocking). Use this for quick progress checks mid-run or in a polling loop. For the common case of 'wait until done', use `task_wait` instead — that's a single blocking call rather than a polling loop and is far easier for an LLM to use.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The taskId returned by the prior `task` call" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "cancel_task",
    description:
      "Cancels a task started by this host. Works on both `awaiting_confirmation` tasks (dismisses the user prompt as deny) and `running` tasks (aborts the agent loop, closes its owned tabs unless the user opted to keep them).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The taskId returned by the prior `task` call" },
      },
      required: ["taskId"],
    },
  },
] as const satisfies readonly ToolSchema[];

export type ToolName = (typeof ALL_TOOLS)[number]["name"];

export const TOOL_SCOPES: Record<ToolName, string> = {
  get_context: "list_windows",
  list_windows: "list_windows",
  list_spaces: "list_spaces",
  read_page: "read_page",
  screenshot: "screenshot",
  open_url: "open_url",
  task: "task",
  task_status: "task",
  task_wait: "task",
  cancel_task: "task",
};
