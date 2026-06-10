import { createContext, useContext } from "react";

/**
 * Exposes the active conversation's id to descendant chat components.
 *
 * Most components receive `conversationId` via props, but a few deeply
 * nested result renderers (e.g. `DelegateResult`) need it without a
 * five-level prop drill. The provider lives at `ChatView`, which owns
 * the `conversationId` prop.
 *
 * `null` is the legitimate fallback when no provider is mounted (e.g. a
 * brand-new unsaved conversation, isolated tests, or settings previews);
 * consumers must treat `null` as "no conversation" rather than throwing.
 */
export const ConversationIdContext = createContext<string | null>(null);

/** Read the active conversation id. Returns `null` outside any provider. */
export function useConversationId(): string | null {
  return useContext(ConversationIdContext);
}
