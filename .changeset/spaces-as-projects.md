---
"openbrowse": minor
---

**Spaces are now projects.** Each Space carries its own instructions, files, memories, and skills — a self-contained working context for one kind of work (a client, a research topic, a side project). Configuration lives **inline on the chat landing page**: a sticky header with the Space's icon, name, description, and color, plus a right-rail panel for Instructions / Files / Memory / Skills. The standalone "configure space" detail page is gone; you no longer leave chat to tweak a Space.

**Two workspaces: per-chat and per-Space.** Every conversation still has its own working folder where the agent writes files by default — that doesn't change. What's new is that each Space gets its own **shared** workspace that's visible to every conversation bound to it. The agent can read it freely; writes to it go through approval. When a file the agent produced in a chat is worth keeping around, **save it to the Space** with one click and it gets promoted into the shared workspace; re-saving overwrites the same destination instead of stamping `(2)`/`(3)` duplicates. A small indicator on each working-folder file shows whether it's unsaved, saved, or stale (the source has changed since you saved). Files dropped on a Space's landing page upload straight into the shared workspace; clicking any file card opens it in a viewer in the same right rail (no new tab, no modal).

**Memory is scoped per Space (or global).** When the agent records a memory mid-conversation, it goes to the active Space by default; ask it to save a memory globally and it lands in your user-wide memory instead. Recall returns up to two matches — the global one and the space-scoped one — so a same-titled space memory never hides a global one. Each Space's memories show up in its rail, and global memories stay in Settings.

**Skills are scoped too.** Each Space picks which personal skills are active for its agent (built-ins are always on). Install a skill from a URL or upload one as a `.zip`/`.tar.gz` directly from the Space's rail.

**No-Space conversations are first-class.** Starting a chat without picking a Space no longer forces a default Space onto you — chat works without one, and the side panel and home both reflect that.

**Per-conversation file references.** As the agent reads from a Space's workspace, the conversation records which files it touched. The Context card in the rail surfaces them as clickable cards so you can jump back to the exact file that informed the answer.

**Reload-safe URLs.** The home page now hash-routes (`#chat` / `#scheduled` / `#spaces` / `#<conversationId>`) and Settings query-routes (`?tab=…`), so reload, Back, and Forward all land you back where you were.

**Sidebar refresh.** Logo + Space name is now a single Go-home button; a dropdown beside it surfaces per-Space actions. The version stamp sits next to the logo when no Space is active.

**Composer halo.** The chat composer paints a soft gradient halo in the active Space's color on focus — dimmed to 60% opacity in dark mode so saturated colors don't read as glaring.

**Card-grid Spaces page.** The Spaces tab is now a card grid sorted by recent activity. Press `/` to focus the search; Esc clears it. Click a card to open that Space.

**Scheduled view parity.** The scheduled-tasks page now matches the Spaces page visually — same card grid, same `/`-focus search, same dashed-border empty state.
