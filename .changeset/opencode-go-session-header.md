---
"openbrowse": patch
---

Fix OpenCode Go failing every request with `Request is missing x-opencode-session and cannot be routed efficiently` (HTTP 400 `MissingSessionID`).

OpenCode Go routes and prompt-caches by a client-supplied session id and rejects requests that carry none, before it even checks the API key. The OpenCode Go provider (from the models.dev catalog) built its model with no way to attach headers, so nothing was ever sent.

- **One session id per conversation.** The conversation id — already persisted in the chat DB — is sent as `x-opencode-session`, so it is identical across every turn, every step of a tool loop, SDK retries and reloads, and different for each new conversation. No new storage, and a fresh id is never minted per request. Compaction, the completion-check evaluator, the curator, the Computer Use subagent, chat titles and tab-group labels all join their conversation's session.
- **One-off requests** that belong to no conversation (the Settings connection test) get their own single-use id instead of failing with the same error.
- **Only OpenCode Go.** The header is keyed to the `opencode-go` provider id, so OpenCode Zen and every other provider — including ones built on the same SDK — are unchanged. Each model keeps its own wire protocol (`/chat/completions`, `/messages` for Qwen and MiniMax, `/responses`), and the header rides on whichever one is used. Gemini models on OpenCode Go are not covered: the bundled Google adapter ignores the gateway base URL, which is a separate pre-existing problem.
