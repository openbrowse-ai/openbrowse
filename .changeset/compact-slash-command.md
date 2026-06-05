---
"openbrowse": minor
---

Add a `/compact` slash command to the chat composer. Typing `/` now lists
built-in commands (under a "Commands" group) alongside skills; selecting
`/compact` manually compacts the conversation — summarizing the full history
and sending only that summary to the model on the next turn, while the UI
keeps showing every original message. Supports "compact-then-send" (`/compact
<text>` compacts, then sends the remaining text) and surfaces a toast for every
outcome (compacted, too short, or failure).

Also fixes the compaction model resolution so it correctly handles the stored
`provider:model` key (previously it failed to find a provider, which silently
broke both manual and automatic compaction).
