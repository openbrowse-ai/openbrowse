---
"openbrowse": patch
---

Fix tool-approval "Always allow", add other-tab awareness, and assorted abort/UX fixes:

- Respect "Always allow" by calling `needsApproval` with the AI SDK's positional `input` argument (previously `input` was always `undefined`, so the same-origin allowlist was never consulted and approval was always required).
- Surface the user's other open tabs to the agent as an awareness-only `## Other open tabs` block. Titles/URLs are sanitized (newlines/control chars collapsed, length-capped) before reaching the system prompt to prevent prompt injection, and only `http(s)` URLs are exposed.
- Bind the shared active tab on the first message of a new conversation so the legend marks it `[active]` immediately; the bind now honors a `{ ok: false }` background response instead of pinning an unbound tab.
- Skip the completion check when the user aborts generation (the SDK emits an `abort` chunk and closes cleanly, which previously caused the check to grade an abandoned draft).
- Stop TipTap from nesting pasted markdown links on each copy/paste/resend cycle.
- Disable per-word stagger in the markdown renderer to fix concurrent/parallel reveal of streamed sections.
