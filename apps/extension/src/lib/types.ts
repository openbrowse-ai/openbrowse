import type { UIMessage } from "ai";
import type { McpServerConfig } from "./mcp/types";

export interface FavoriteTab {
  url: string;
  title: string;
  favicon: string;
  position: number;
}

export interface FavoriteTabAssociation {
  favoriteUrl: string;
  tabId: number;
  currentUrl: string;
  currentTitle: string;
  currentFavicon: string;
}

export interface Space {
  id: string;
  name: string;
  icon: string | null;
  windowId: number | null;
  position: number;
  favorites: FavoriteTab[];
  colors: string[] | null;
  colorMode: "auto" | "light" | "dark" | null;
}

export interface PageContext {
  h1: string;
  description: string;
  snippet: string;
  type: string;
  siteName: string;
}

export type ThemeMode = "system" | "light" | "dark";

export type AIProvider = "browser-ai" | "web-llm" | "cloud" | "disabled";

export type CloudProvider = "openai" | "anthropic" | "google" | "openai-compatible";

export interface Settings {
  // General
  themeMode: ThemeMode;
  autoTidyAfterMinutes: number;
  agentGroupIdleHours: number;
  archiveAggressiveness: "low" | "medium" | "high";
  tidyModel: string; // "providerId:modelId"
  notificationsEnabled: boolean;

  // Models
  providerConfigs: Record<string, Record<string, string>>; // providerId → config values
  favoriteModels: string[]; // ["openai:gpt-4o", "anthropic:claude-sonnet-4-6"]
  downloadedModels: string[]; // for web-llm model IDs

  // Connectors
  mcpServers: McpServerConfig[];

  // DEPRECATED — kept for migration only
  aiProvider?: AIProvider;
  cloudProvider?: CloudProvider;
  cloudApiKey?: string;
  cloudApiKeys?: Partial<Record<CloudProvider, string>>;
  cloudModel?: string;
  cloudBaseUrl?: string;
  webllmModel?: string;
}

export type ThinkingConfig =
  | { type: "budget"; tokens: number }
  | { type: "effort"; level: string };

export interface AgentSettings {
  agentModel: string;
  compactionModel?: string;
  thinkingEnabled?: boolean;
  thinkingConfig?: ThinkingConfig;
}

export interface Conversation {
  id: string;
  title: string;
  spaceId: string | null;
  ownedGroupId: number | null;
  ownedTabIds: number[];
  todos?: TodoItem[];
  createdAt: number;
  updatedAt: number;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
  createdAt: number;
  updatedAt: number;
}

export * from "./agent/message-types";

export interface ModelStatus {
  provider: AIProvider;
  availability:
    | "available"
    | "downloadable"
    | "unavailable"
    | "checking"
    | "error";
  message: string;
}

export type MessageType =
  | {
      type: "SORT_TABS";
      tabs: { id: string; url: string; title: string }[];
      provider?: AIProvider;
      modelId?: string;
      cloudConfig?: {
        cloudProvider: Settings["cloudProvider"];
        cloudApiKey: string;
        cloudModel: string;
        cloudBaseUrl: string;
      };
    }
  | {
      type: "CHECK_AVAILABILITY";
      provider: AIProvider;
      webllmModel?: string;
      cloudConfig?: {
        cloudProvider: Settings["cloudProvider"];
        cloudApiKey: string;
        cloudModel: string;
        cloudBaseUrl: string;
      };
    }
  | {
      type: "TEST_CONNECTION";
      provider: AIProvider;
      webllmModel?: string;
      cloudConfig?: {
        cloudProvider: Settings["cloudProvider"];
        cloudApiKey: string;
        cloudModel: string;
        cloudBaseUrl: string;
      };
    }
  | {
      type: "TEST_CONNECTION_REGISTRY";
      providerId: string;
      config: Record<string, string>;
      modelId?: string;
    }
  | {
      type: "GENERATE_CHAT_TITLE";
      providerId: string;
      config: Record<string, string>;
      modelId?: string;
      userMessage: string;
    }
  | { type: "DOWNLOAD_MODEL"; modelId: string }
  | { type: "DOWNLOAD_BROWSER_AI" }
  | { type: "CHECK_MODEL_CACHE"; modelIds: string[] }
  | { type: "DELETE_MODEL"; modelId: string }
  | {
      type: "GENERATE_GROUP_LABEL";
      providerId: string;
      config: Record<string, string>;
      modelId?: string;
      context: {
        chatTitle: string;
        userMessage: string;
        tabs: { title: string; url: string }[];
      };
    }
  | {
      type: "PYTHON_EXECUTE";
      conversationId: string;
      code: string;
      input?: string;
      timeoutMs?: number;
      resetState?: boolean;
      allowNetwork?: boolean;
    }
  | { type: "PYTHON_WARMUP"; conversationId: string }
  | { type: "PYTHON_RESET"; conversationId: string }
  | { type: "PYTHON_DISPOSE"; conversationId: string }
  | { type: "PYTHON_GET_LOG" }
  | { type: "PYTHON_CLEAR_LOG" };

export type SortResult = {
  sections: { name: string; tabs: { id: string; tidiedTitle: string }[] }[];
  tabs: { id: string; tidiedTitle: string }[];
  archivedTabIds?: string[];
};

export interface TidySection {
  id: string;
  name: string;
  position: number;
  collapsed: boolean;
}

export interface TidyState {
  sections: TidySection[];
  tabAssignments: Record<number, string>;
  tidiedTitles: Record<number, string>;
  manualTitles: Record<number, string>;
}

export interface AutoTidyNotification {
  timestamp: number;
  archivedCount: number;
  sectionCount: number;
  tabCount: number;
}

export interface HistoryItem {
  id: string;
  url: string;
  title: string;
  lastVisitTime: number;
  visitCount: number;
}
