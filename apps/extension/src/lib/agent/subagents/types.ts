/**
 * Subagent type definitions.
 *
 * Subagents are nested `ToolLoopAgent` instances delegated from the parent
 * conversation's agent. Each subagent has its own system prompt, tool
 * allowlist, model, and (optionally) its own conversation, tab group, and
 * window — see `IsolationProfile`.
 *
 * Design references:
 *   - .superpowers/specs/2026-05-25-subagents-design.md
 *   - Convergent pattern across Claude Code, Codex, Roo Code, AI SDK 6.x:
 *     fresh context + structured handoff + summary-only return.
 */

import type { SerializedUIPart } from "../message-types";

/**
 * How a subagent is isolated from its parent.
 *
 *   - `peer`       — new child Conversation, own tab group in the same window.
 *   - `incognito`  — like peer but in a fresh incognito window (auto-closed).
 *   - `attached`   — operates on the PARENT's existing live tab(s). The runner
 *                    seeds the child handle map with the parent's real tab id
 *                    (resolved from DelegationContext.parentTabHandle). No new
 *                    tab group is created. Used by the CUA subagent so it can
 *                    perceive/act on the exact page the parent is working on.
 */
export type IsolationProfile = "peer" | "incognito" | "attached";

/**
 * Status of a subagent run, persisted on the child Conversation row when
 * `isolation` is `peer` or `incognito`.
 */
export type SubagentStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget-exceeded";

/**
 * Static definition of a subagent. Hard-coded built-ins live in
 * `subagents/built-ins/*.ts`; user-defined agents (deferred to a later
 * phase) will load from OPFS markdown.
 */
export interface AgentDefinition {
  /** Stable identifier; used in `delegate({slug})` and `@agent:<slug>`. */
  slug: string;
  /** One-line summary of the agent's job. Surfaced in the `delegate` tool description and UI labels. */
  description: string;
  /** Routing hint for the parent LLM ("Use this when ..."). Distinct from `description`. */
  whenToUse: string;
  /**
   * Full system prompt for the subagent. The runner appends standard
   * environment details (cwd, today's date, etc.) but does NOT include
   * the parent's system prompt — subagents are fresh-context.
   */
  systemPrompt: string;
  /** Default isolation if the parent does not pass `isolation` to `delegate`. */
  defaultIsolation: IsolationProfile;
  /**
   * Tool name allowlist. The runner filters the parent's tool set down to
   * these. The `delegate` tool is always stripped (depth cap = 1) regardless
   * of what's listed here.
   */
  allowedTools: string[];
  /** Tool name denylist applied AFTER `allowedTools`. */
  deniedTools?: string[];
  /** Model override (`providerId/modelId`). Defaults to the parent's model. */
  defaultModel?: string;
  /** Step cap forwarded to `stopWhen`. Defaults to 30. */
  maxSteps?: number;
  /** Theme color or hex; rendered on the subagent badge. */
  color?: string;
  /** Origin of the definition. Built-ins ship in code; user agents will load from OPFS. */
  source: "built-in" | "user";
  /**
   * How the subagent's tool set is assembled.
   *   - `inherit` (default): filter the parent's tools by `allowedTools`.
   *   - `custom`: ignore parent tools; build from `custom` (see below).
   */
  toolSource?: "inherit" | "custom";
  /**
   * Custom tool/loop configuration, read only when `toolSource === "custom"`.
   * Discriminated by `kind`. The runner switches on this to pick a loop
   * strategy (e.g. a CUA provider) instead of the standard ToolLoopAgent.
   */
  custom?: CustomAgentConfig;
}

/** Configuration for a `toolSource: "custom"` agent. */
export type CustomAgentConfig = {
  kind: "cua";
  /** Max viewport width declared to the CUA model (CSS px). Default 1280. */
  maxDisplayWidth?: number;
};

/**
 * Structured handoff the parent assembles when calling `delegate`. The
 * subagent's first user message is built from this — there is no
 * inheritance of the parent's chat history (fresh-context contract).
 */
export interface DelegationContext {
  /** The user-facing task description. */
  task: string;
  /** Parent's tab handles ("t3") the subagent may read. */
  tabHandles?: string[];
  /** Explicit URL list, when no tab handle is appropriate. */
  urls?: string[];
  /** OPFS paths the runner should expose to the child workspace. */
  workspaceFiles?: string[];
  /**
   * For `inline` isolation: the page being discussed. The subagent's
   * `targetTabId` is set to this on the first tab-interacting tool call.
   */
  parentTabHandle?: string;
  /** Freeform additional context the parent wants to pass through. */
  notes?: string;
}

/**
 * Returned to the parent's `delegate` tool execute. The final text is what
 * the parent's LLM sees; the rest is metadata.
 */
export interface SubagentRunResult {
  /**
   * The last assistant text the subagent emitted, or a runner-synthesized
   * failure phrase on errors. Markdown OK. Returned to the parent's loop.
   */
  finalText: string;
  /** Child conversation id, or `null` for `inline` isolation. */
  childConversationId: string | null;
  /** OPFS paths the subagent created or modified. */
  filesProduced?: string[];
  /** Tab handles the subagent created (in its own window/group). */
  tabHandlesProduced?: string[];
  /** Terminal status. */
  status: Exclude<SubagentStatus, "running">;
  /** Populated when `status` is `failed` or `budget-exceeded`. */
  errorMessage?: string;
  /**
   * Captured transcript of the subagent's assistant turns — one entry per
   * UIMessage emitted during the run. Populated for ALL profiles so the
   * parent's `DelegateResult` block can render the trace inline (using
   * the same `ToolCallBlock` components the main chat uses).
   *
   * For `peer` / `incognito`, this is the same content already
   * persisted under the child conversation id; including it on the
   * result lets the parent render without a chat-db round-trip and
   * lets older clients ignore the field harmlessly.
   *
   * For `inline`, this is the only place the transcript lives — inline
   * runs do not persist messages anywhere else.
   */
  transcript?: SerializedAssistantMessage[];
}

/**
 * One assistant message captured from a subagent run, serialized in the
 * same shape chat-db uses (`SerializedUIPart[]`). Suitable for
 * round-tripping through tool results without further conversion.
 */
export interface SerializedAssistantMessage {
  id: string;
  parts: SerializedUIPart[];
}
