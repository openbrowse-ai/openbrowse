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
