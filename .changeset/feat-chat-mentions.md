---
"openbrowse": minor
---

**Mention past chats in the composer.** Type `@` in the chat composer to reference open tabs _and_ previous conversations from one unified popup. Selecting a chat inserts a chat chip, and on send the referenced conversation's transcript is injected as context for the model — so you can pick up a thread, cross-reference an earlier decision, or ask the agent to build on prior work without re-pasting anything.

`@` now surfaces two labelled groups (Tabs and Past chats) over a single keyboard cursor, mirroring how `/` lists commands and skills:

- The unified `@` suggestion queries open tabs and `chatDb.listRootConversations()` (recent-first, fuzzy-filtered by title, subagent child runs excluded) and inserts the right node per selection: tabs become `tabMention` nodes (`@[title](url)`), chats become `chatMention` nodes (`#[title](chat:id)`). Distinct node types and markdown tokens keep the two paths unambiguous, so existing tab behaviour is untouched.
- Chat chips render as `@Title` in the composer and in sent-message history (via a read-only node variant), styled with a `.chat-mention` chip class across the side panel and home surfaces.

**Context injection (both tabs and chats) is now carried as a message part, not inline text.** The resolved context — mentioned tabs' page content and mentioned chats' transcripts — is captured at send time (preserving the tab/chat snapshot the user saw) and attached to the user message as a persisted, UI-invisible `data-mention-context` part. The transport substitutes it into a text part immediately before the model request (`rewriteForLLM` → `substituteMentionContextPart`), so:

- the composer bubble renders only the user's text + chips, with **no display-side stripping** (removing a class of "context leaked into the bubble" bugs);
- the model's view stays **consistent across reloads** (the part round-trips through chat-db); and
- there's a **single injection point** in the transport rather than context smuggled through the text and re-hidden in every render/edit surface.

Transcripts skip system rows and auto-compaction summaries and de-duplicate by conversation id; the part's text is counted by `estimateMessageTokens` so compaction triggers accurately. Wired into all send paths: initial send, queue-while-streaming, message edit, and the landing/hero composer.

**Long chats are summarized, not truncated.** When a mentioned chat's transcript exceeds a token threshold, it's condensed with a compaction-style summary (via the user's configured compaction model) instead of pasting an arbitrary head slice. Summaries are generated once and cached for the session (keyed by message count + last message id, so a chat that grows re-summarizes); if summarization is unavailable the block falls back to a truncated transcript. The reusable summarizer (`summarizeMessages`) is factored out of the live compaction flow.

**Shimmer feedback while summarizing.** A long-chat summary resolves at send time, so every send path gives feedback with the mention chip shimmering (a `.chat-mention-resolving` CSS sweep) until the context is ready and the turn dispatches — the send/transport path itself is untouched:

- **Side panel** (in-conversation sends and message edits): an optimistic `PendingMentionBubble` echoes the message while `handleSubmit`/`confirmEdit` resolves the context, then the real turn dispatches.
- **Queue-while-streaming**: enqueuing a message that references a chat clears the composer immediately and shows an optimistic, pulsing placeholder row in the queue while the snapshot resolves, then the real queued item replaces it.
- **Home landing hero** (new-chat sends): the send navigates to the chat view _immediately_ (persisting clean text), and mention resolution is deferred to the first-turn dispatch — so the real message renders right away and its chip shimmers in place while its referenced chats are summarized, then the turn dispatches. No frozen hero, no message-bubble-on-hero hybrid.

**Test surface.** +16 tests: chat-mention token parsing, verbatim transcript formatting (injection, system/summary filtering, empty placeholder), long-chat summarization routing (threshold, cache hit, cache invalidation, fallback), and the transport contract (data part → model text substitution, untouched-when-absent, serialize/deserialize round-trip).
