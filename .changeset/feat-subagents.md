---
"openbrowse": minor
---

Subagents: the chat agent can now delegate focused tasks to specialized subagents that run with fresh context, their own tool allowlist, and isolated tab/window state.

- **`explore`** — read-only research subagent. Use for background investigation that should not mutate state.
- **`general`** — read/write subagent for general-purpose delegation when the parent's tools fit but the work would bloat the parent's context with verbose output.

Each delegation appears inline as a collapsible trace block with a live transcript, a step counter, and a phase title the subagent updates as it works. Subagents run with isolation: `peer` puts the child in its own tab group within the same window (default), and `incognito` opens a fresh incognito window with no shared cookies/auth/storage that auto-closes when done. Stop now correctly cancels in-flight subagents along with the parent.
