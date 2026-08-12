import { AGENT_RUN } from "@/entrypoints/background/agent-host/messages";
import type { AgentSettings, Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  themeMode: "system",
  autoTidyAfterMinutes: 360,
  autoCloseCompletedAgentTabs: false,
  autoCloseCompletedAgentTabsAfterMinutes: 30,
  archiveAggressiveness: "medium",
  tidyModel: "",
  notificationsEnabled: true,
  providerConfigs: {},
  favoriteModels: [],
  downloadedModels: [],
  mcpServers: [],
};

export const WEBLLM_MODELS = [
  {
    id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 3B",
    size: "~2 GB",
  },
  {
    id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    name: "Llama 3.2 1B",
    size: "~0.7 GB",
  },
  { id: "gemma-2-2b-it-q4f16_1-MLC", name: "Gemma 2 2B", size: "~1.4 GB" },
  {
    id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC",
    name: "Hermes 3 3B",
    size: "~2 GB",
  },
  {
    id: "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC",
    name: "DeepSeek R1 7B",
    size: "~4 GB",
  },
  {
    id: "Phi-3.5-mini-instruct-q4f16_1-MLC",
    name: "Phi 3.5 Mini",
    size: "~2.2 GB",
  },
  {
    id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    name: "Qwen 2.5 1.5B",
    size: "~1 GB",
  },
  {
    id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC",
    name: "SmolLM2 1.7B",
    size: "~1 GB",
  },
] as const;


export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  agentModel: "",
};

export const STORAGE_KEYS = {
  SPACES: "spaces",
  SETTINGS: "settings",
  AGENT_SETTINGS: "agent-settings",
  MCP_SERVERS: "mcp-servers",
  AUTO_TIDY_NOTIFICATION: "auto-tidy-notification",
  ACTIVE_AGENTS: "active-agents",
  MODELS_DEV_CATALOG: "models-dev-catalog",
} as const;

export const HOME_PAGE_URL = "/home.html";

export const AUTO_TIDY_CHECK_INTERVAL_MS = 60_000;

/**
 * Cross-context runtime message types for the single-host run model.
 *
 *  - STREAM_PARTS: the SW host broadcasts a throttled full-message snapshot
 *    of the in-flight assistant message so renderer surfaces that joined
 *    late (or were frozen mid-run) can catch up on display state.
 *  - STREAM_DONE: the SW host signals a turn reached a terminal state;
 *    renderers re-read the authoritative transcript from chat-db.
 *  - AGENT_APPROVE: legacy renderer→renderer approval forward; retained
 *    while the renderer-host loop is still in place during the SW-host
 *    migration. New code uses the per-conversation `agent-run:` Port and
 *    the `AGENT_RUN.APPROVE` payload type (see
 *    `entrypoints/background/agent-host/messages.ts`).
 *  - AGENT_ANSWER: viewer→host forward of an `askUser` answer. `askUser`
 *    is a client-side tool, so its result is produced in the renderer
 *    (`addToolOutput`) rather than by the SW; a viewer surface therefore
 *    needs the same host bridge that AGENT_APPROVE provides for approvals.
 *
 * `AGENT_STOP` (defined inline elsewhere) is reused for viewer→host stop.
 *
 * The `AGENT_RUN_*` set on `agent-host/messages.ts` is the canonical
 * SW-host channel. They are re-exported here only so non-Port code that
 * needs to filter generic runtime messages can prefix-match by name
 * without depending on the agent-host module. Derived directly from
 * `AGENT_RUN` so the two surfaces can never drift.
 */
export const RUNTIME_MESSAGES = {
  STREAM_PARTS: "STREAM_PARTS",
  STREAM_DONE: "STREAM_DONE",
  AGENT_APPROVE: "AGENT_APPROVE",
  AGENT_ANSWER: "AGENT_ANSWER",
  AGENT_RUN_START: AGENT_RUN.START,
  AGENT_RUN_STOP: AGENT_RUN.STOP,
  AGENT_RUN_APPROVE: AGENT_RUN.APPROVE,
  AGENT_RUN_REGEN: AGENT_RUN.REGEN,
  AGENT_RUN_ACK: AGENT_RUN.ACK,
  AGENT_RUN_CHUNK: AGENT_RUN.CHUNK,
  AGENT_RUN_DONE: AGENT_RUN.DONE,
  AGENT_RUN_ERROR: AGENT_RUN.ERROR,
} as const;

/** Throttle interval for host→viewer streaming snapshots. */
export const STREAM_MIRROR_THROTTLE_MS = 100;
