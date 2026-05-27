/**
 * Module-scoped holder for the currently-active executor `LanguageModel`.
 *
 * Lives in its own small module (rather than `agent-transport.ts`) so
 * tools and the Goal Contract evaluator can read the active model
 * without transitively importing the full agent-transport dependency
 * tree — which pulls in `chrome.runtime` at module-load time and breaks
 * unit tests running in Node.
 *
 * The transport is the sole writer; readers should never write here
 * outside of testing helpers (the existing `setCurrentAgentModel` is
 * exported for that reason).
 */

import type { LanguageModel } from "ai";

let currentAgentModel: LanguageModel | null = null;

/**
 * Returns the executor model for the currently-active agent run, or
 * `null` if no agent run is active. Tools (`extract`) and the Goal
 * Contract evaluator read this when they need an LLM but don't have
 * one threaded explicitly.
 */
export function getCurrentAgentModel(): LanguageModel | null {
  return currentAgentModel;
}

/**
 * Set the active model. Called by `createAgentTransport` when it
 * resolves the user's chosen agent model. Tests may also call this
 * directly to inject a mock model when exercising tools or the
 * evaluator in isolation.
 */
export function setCurrentAgentModel(model: LanguageModel | null): void {
  currentAgentModel = model;
}
