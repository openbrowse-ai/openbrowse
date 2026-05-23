/**
 * Pure-logic helpers for the chat input UI. Extracted from
 * `ChatInput.tsx` so they can be unit tested without dragging the
 * full React + tiptap + chrome bundle into the test environment.
 */

export type ChatInputButtonMode = "send" | "stop" | "queue";

/**
 * Computes the primary action button's mode from the input state.
 *
 * Precedence (top wins):
 *  1. `editMode` → always "send" (renders as a Save button).
 *     This branch is what guarantees the Save button can't morph into
 *     Stop while the user is editing a queued message during streaming.
 *  2. `isLoading + hasContent + hasOnQueue` → "queue".
 *  3. `isLoading` → "stop".
 *  4. otherwise → "send".
 */
export function computeButtonMode({
  editMode,
  isLoading,
  hasContent,
  hasOnQueue,
}: {
  editMode: boolean;
  isLoading: boolean;
  hasContent: boolean;
  hasOnQueue: boolean;
}): ChatInputButtonMode {
  if (editMode) return "send";
  if (isLoading) {
    return hasContent && hasOnQueue ? "queue" : "stop";
  }
  return "send";
}
