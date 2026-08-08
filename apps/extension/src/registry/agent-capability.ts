import { getUsableTokens } from "@/lib/agent/compaction";

/**
 * Can a model serve as the **main browser-use agent**?
 *
 * The agent loop is driven entirely by tool calls and carries a large,
 * non-compactable per-turn floor (system prompt + every tool's JSON schema +
 * the current page's accessibility snapshot). Two hard requirements follow:
 *
 *  1. **Tool calling.** Without it there is nothing for the loop to drive.
 *  2. **A viable context window.** When `getUsableTokens` (context − max
 *     output − compaction buffer) is non-positive, a single turn cannot fit
 *     and the compaction math degenerates into always-compact thrash. That
 *     is the principled line below which a model is not agent-usable.
 *
 * This gate is intentionally scoped to the *primary agent* selection (chat
 * composer, scheduled-task runner). Utility roles — tab tidy, chat-title and
 * group-label generation, compaction summaries, completion evaluation — do
 * NOT use it, because chat-only models are perfectly fine there.
 */

export interface AgentModelGateResult {
  ok: boolean;
  /** Short badge text shown on a gated-out picker row (e.g. "Chat only"). */
  reason?: string;
  /** Longer explanation for tooltips / error surfaces. */
  detail?: string;
  /**
   * When `ok` is false, whether the picker should still allow selecting the
   * model (rendering `reason` as an advisory badge rather than disabling the
   * row). Used by the composer, where a chat-only model is a legitimate
   * choice that runs the lightweight chat-only path instead of the agent.
   */
  allowSelect?: boolean;
}

/** The subset of model metadata the gate reads. */
export interface AgentGateModel {
  capabilities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export function agentModelGate(model: AgentGateModel): AgentModelGateResult {
  const capabilities = model.capabilities ?? [];

  if (!capabilities.includes("tools")) {
    return {
      ok: false,
      reason: "Chat only",
      detail:
        "This model can't call tools, so it can't drive the browser agent. It's still available for chat-only features like tab tidy and title generation.",
    };
  }

  // Only gate on context when the window is known. An unknown window falls
  // back to the compaction default (large), so we give it the benefit of the
  // doubt rather than hiding a legitimate model with missing metadata.
  if (model.contextWindow != null && getUsableTokens(model) <= 0) {
    return {
      ok: false,
      reason: "Context too small",
      detail:
        "This model's context window is too small to run the browser agent — the system prompt, tool definitions, and page state don't fit in a single turn.",
    };
  }

  return { ok: true };
}

/** Convenience boolean form of {@link agentModelGate}. */
export function isAgentCapableModel(model: AgentGateModel): boolean {
  return agentModelGate(model).ok;
}

/**
 * Does this model lack tool calling, and therefore run the lightweight
 * chat-only path instead of the browser agent? (See `createChatOnlyTransport`.)
 *
 * Callers must only apply this to a model they actually resolved. A missing
 * `ModelDefinition` means "unknown", NOT "chat-only" — routing an unresolved
 * model here would silently strip every tool from a perfectly tool-capable
 * model (e.g. a gateway/dynamic model absent from a provider's static list).
 */
export function isChatOnlyModel(model: AgentGateModel): boolean {
  return !(model.capabilities ?? []).includes("tools");
}

/**
 * Gate for the **chat composer** model picker. Identical to {@link agentModelGate}
 * except a chat-only model (lacks `tools`) is marked `allowSelect: true`: it
 * can't drive the browser agent, but the composer still lets the user pick it
 * to hold a plain conversation via the chat-only transport. The "Context too
 * small" case stays hard-disabled — that only applies to tool-capable models
 * whose window can't fit the agent prompt, which chat-only mode never builds.
 */
export function composerModelGate(model: AgentGateModel): AgentModelGateResult {
  const result = agentModelGate(model);
  if (!result.ok && !(model.capabilities ?? []).includes("tools")) {
    return { ...result, allowSelect: true };
  }
  return result;
}
