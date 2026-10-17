import type { ModelRequestContext } from "./types";

/**
 * Session context for the request(s) of a conversation. The conversation id
 * is already persisted in the chat DB, so using it as the session id gives a
 * value that is stable across turns, tool-loop steps, retries and reloads,
 * and distinct per conversation, without any extra storage.
 *
 * A missing id yields an empty context: the provider then sends no session
 * header rather than inventing one that would change on the next request.
 */
export function conversationRequestContext(
  conversationId: string | null | undefined,
): ModelRequestContext {
  return conversationId ? { sessionId: conversationId } : {};
}

/**
 * Context for a one-off request that belongs to no conversation (the settings
 * connection test). The id is minted once per call, never per retry: retries
 * reuse the model instance this context was built into.
 */
export function oneShotRequestContext(): ModelRequestContext {
  return { sessionId: crypto.randomUUID() };
}
