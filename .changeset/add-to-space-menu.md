---
"openbrowse": patch
---

**Add an "Add to space" action to the chat thread actions menu.**

The chat header's ⋯ menu now has an "Add to space" submenu listing your spaces.
Selecting one moves the conversation into that space; the space it already
belongs to is disabled, and a "Remove from space" item appears when the
conversation is currently in a space (moving it back to the global scope). The
sidebar re-scopes immediately in the same window via a `chat-moved` event, since
the cross-window `CONVERSATION_UPDATED` broadcast isn't delivered to the sender's
own context.
