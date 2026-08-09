// src/components/memory/source-chat.ts
//
// Click behavior for a `[[chat:<conversationId>]]` provenance link in a memory
// note (see `lib/memory/linkify.ts`).
//
// Memory outlives conversations \u2014 a note can easily reference a chat the user
// has since deleted \u2014 so the id is verified against `chatDb` before navigating.
// Without the check the user lands in an empty chat with no explanation.
//
// Navigation itself is host-dependent, hence the optional `navigate`:
//   - Inside the home app, pass the app's own conversation switcher so the link
//     navigates in place.
//   - From Settings (a separate top-level entrypoint that can't drive the home
//     app's router), omit it and fall back to `openOrFocusConversation`, which
//     focuses an existing `home.html#<id>` tab or opens one.

import { openOrFocusConversation } from "@/entrypoints/settings/mcp-bridge/open-conversation";
import { chatDb } from "@/lib/chat-db";
import { toast } from "sonner";

export async function openSourceChat(
  conversationId: string,
  navigate?: (conversationId: string) => void,
): Promise<void> {
  let exists = false;
  try {
    exists = (await chatDb.getConversation(conversationId)) != null;
  } catch {
    // Treat a lookup failure as "unknown" rather than "missing": better to
    // attempt the navigation than to wrongly tell the user it's gone.
    exists = true;
  }

  if (!exists) {
    toast.error("That conversation no longer exists.");
    return;
  }

  if (navigate) {
    navigate(conversationId);
    return;
  }
  await openOrFocusConversation(conversationId);
}
