---
"openbrowse": minor
---

Surface the agent's plan, workspace files, and context in the side panel, and
fix conversation context for new chats and subagents.

The side-panel composer gains a cowork bar: a tabbed strip (Plan / Workspace
files / Context) with a glanceable label, click-to-expand panels, an animated
height, and an in-panel file viewer — so the narrow side panel gets the same
plan/files/context surfaces the home view has in its rail. The chat header also
gains the context-usage chip (token/cost radial + popover). The shared cowork
cards were extracted into a common module so home and side panel render from
one source.

Also fixes a conversation-context bug: `executePython` and the file tools
(Read/Write/Edit/Glob/Grep/LS) captured the conversation id in a build-time
closure, so a brand-new chat failed with "No conversation context" and the file
tools silently wrote to the wrong workspace root (a latent variant also
affected subagents). They now resolve the id from the call-time tool context,
matching the existing delegate tool.
