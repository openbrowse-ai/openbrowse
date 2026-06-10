import type { UIMessage } from "ai";
import type { CompletionCheckSettings } from "./agent/completion-check/types";
import type { IsolationProfile, SubagentStatus } from "./agent/subagents/types";
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
  /**
   * URLs of the space's pinned tabs (Chrome native `tab.pinned`), in strip
   * order, excluding the home tab. Persisted so a space's window can be
   * recreated with its pinned tabs and re-matched to its restored window
   * across browser restarts (window ids are not stable).
   */
  pinnedTabs: string[];
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
  /** When on, auto-close a conversation's agent-owned tabs after the task
   * completes (CompletionCheck approved) and the conversation goes idle. */
  autoCloseCompletedAgentTabs: boolean;
  /** Minutes after `taskCompletedAt` before the idle sweep closes the
   * conversation's owned tabs. Only used when the toggle is on. */
  autoCloseCompletedAgentTabsAfterMinutes: number;
  archiveAggressiveness: "low" | "medium" | "high";
  tidyModel: string; // "providerId:modelId"
  notificationsEnabled: boolean;

  // Models
  providerConfigs: Record<string, Record<string, string>>; // providerId → config values
  favoriteModels: string[]; // ["openai:gpt-4o", "anthropic:claude-sonnet-4-6"]
  downloadedModels: string[]; // for web-llm model IDs

  // Connectors
  mcpServers: McpServerConfig[];

  // Completion check (verify-gated completion). The check is always on
  // by default; the only user-facing knob is the evaluator model.
  // Optional for backward compatibility with persisted Settings records
  // that pre-date this feature.
  completionCheck?: CompletionCheckSettings;

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
  /**
   * Model used by the computer-use (CUA) subagent. Must be a
   * computer-use-capable model (compound "providerId:modelId"). When unset,
   * falls back to the `cua` agent definition's `defaultModel`.
   */
  cuaModel?: string;
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

  // Subagent lineage (added in chat-db v8). All optional/nullable so
  // pre-migration rows continue to read back cleanly.
  /** Parent conversation that spawned this run; null for user-rooted conversations. */
  parentConversationId?: string | null;
  /** Slug of the AgentDefinition that produced this conversation. */
  subagentSlug?: string | null;
  /** Live run status, persisted across MV3 service-worker pauses. */
  subagentStatus?: SubagentStatus | null;
  /** The final text the subagent returned to the parent. */
  subagentFinalText?: string | null;
  /**
   * Live trace title set by the subagent itself via the `setTaskTitle`
   * tool. Updated as the subagent moves through phases of work. Surfaces
   * in the parent's `DelegateResult` block and the child conversation's
   * breadcrumb. Falls back to the delegation `task` string when unset.
   */
  subagentTraceTitle?: string | null;
  /** How this conversation is isolated from its parent. */
  isolationProfile?: IsolationProfile | null;
  /** windowId of a incognito window owned by this run, so we can clean up on cancellation. */
  ephemeralWindowId?: number | null;
  /**
   * Connector ids (e.g. "slack", "linear") whose MCP tools the agent has
   * invoked in this conversation. Written live at step-finish time so the
   * Context card can surface them without waiting for end-of-turn message
   * persistence. Deduped; first-seen order.
   */
  usedConnectorIds?: string[];
  /**
   * Skill names the agent has loaded (via the `skill` tool) in this
   * conversation. Written live at step-finish time. Deduped; first-seen order.
   */
  loadedSkillNames?: string[];

  // v13 — agent tab-cleanup completion marker. Set when a turn's
  // CompletionCheck resolves to `approved`. Read by the idle sweep to
  // decide which conversations' owned tabs are eligible for auto-close.
  /** True once a turn's CompletionCheck approved the task as complete. */
  lastCompletionApproved?: boolean;
  /** Timestamp (ms) of the most recent `approved` CompletionCheck verdict. */
  taskCompletedAt?: number;
  /**
   * Token/cost usage snapshot for the conversation, written live at
   * step-finish time by the agent transport. Drives the header Context
   * popover. Optional; undefined on rows created before this field existed
   * and on conversations that have never run a step.
   */
  usage?: ConversationUsage;
}

/**
 * Token/cost usage snapshot persisted on a conversation row.
 *
 * `totalTokens` is the CURRENT context occupancy (latest step's
 * input + output, overwritten each step) — it shrinks after compaction.
 * `costUsd` is CUMULATIVE spend across every step in the conversation.
 * The two intentionally differ in scope.
 */
export interface ConversationUsage {
  /** Latest step's input tokens (current context input). */
  inputTokens: number;
  /** Latest step's output tokens. */
  outputTokens: number;
  /** inputTokens + outputTokens — the current context size. */
  totalTokens: number;
  /** Cumulative USD spent across all steps in this conversation. */
  costUsd: number;
  /** Snapshot of the model's context window at write time. */
  contextWindow: number;
  /** Model id used for the latest step (e.g. "anthropic:claude-..."). */
  modelId: string;
  /**
   * All distinct model ids used across the conversation, in first-seen
   * order (qualified "provider:model" keys). Lets the UI surface that
   * multiple models contributed to the cumulative cost. Always includes
   * the latest `modelId`. Optional for snapshots written before this field
   * existed.
   */
  modelIds?: string[];
  /** ms timestamp of the most recent usage write. */
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

/**
 * A user message that the user typed while the agent was already streaming
 * the previous turn. Persisted in IndexedDB so the queue survives reloads
 * and is shared across panel contexts (sidepanel, detached popup, home).
 *
 * Snapshot semantics:
 *  - `mentionContext` is `formatMentionContext` output captured at queue
 *    time so the agent sees the tab snapshots the user saw.
 *  - `attachmentBlock` + `visionFiles` come from `formatAttachments`,
 *    which already wrote the bytes to the conversation's OPFS workspace
 *    when the user enqueued. The flush path doesn't re-touch OPFS.
 *
 * Drained messages move from `queue-db` into `chat-db` as ordinary user
 * messages just before `sendMessage` is dispatched; they never appear
 * in both stores at once.
 */
export interface QueuedMessage {
  id: string;
  conversationId: string;
  /**
   * The user-typed text BEFORE mention context or attachment block is
   * appended. Kept raw so an "edit queued message" flow can pre-fill
   * the input with what the user typed, not the synthesized blocks.
   */
  text: string;
  /** `formatMentionContext` output captured at queue time. */
  mentionContext: string;
  /** `<Attached files>` block (or empty string) from `formatAttachments`. */
  attachmentBlock: string;
  /** Vision file-parts (data URLs) ready to ship with `sendMessage`. */
  visionFiles: { mediaType: string; url: string }[];
  createdAt: number;
}

