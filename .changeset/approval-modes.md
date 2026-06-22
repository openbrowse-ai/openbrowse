---
"openbrowse": minor
---

**Approval modes.** A new picker in the chat composer lets you pick how the agent gets your permission per conversation: **Ask before acting** (the default — pause and approve each gated action), **Plan before acting** (the agent proposes a plan once; you approve it; it executes within those bounds), and **Act without asking** (no approvals — use only on trusted, repeated workflows). Press **⌘.** to cycle modes from the keyboard.

**Plan mode in detail.** When you're in Plan mode, the agent's first action is always to draft a plan: a goal, the sites it intends to touch, the steps it'll take, and whether it needs network access via Python. The plan card replaces the chat composer so you can review and approve in one keystroke (Enter). If the agent later needs to touch a site you didn't approve up front, you'll be asked once — and that approval extends the plan for the rest of the conversation, so you don't get prompted again for the same site. Extensions show up inline in the chat as small "Plan extended: example.com" notices so you can see the boundary moving. Subagents the planning agent delegates to inherit the same plan, so the boundary you approved binds transitively.

**Verified-read fast path for `executeOnPage`.** Inline JavaScript the agent runs against a page now declares whether it's reading or writing. Read-shaped scripts — that don't click, type, fetch, mutate the DOM, modify storage, or navigate — skip the approval prompt entirely (a static AST check on the script body is the trust mechanism, no allowlist required). Write-shaped scripts behave like before: skip approval on origins you've explicitly trusted, prompt elsewhere. The agent gets clearer guidance about which shape to declare. Net effect: fewer prompts on routine scraping/extraction tasks.

**Act mode safety floor.** Even in Act mode, calling Python with network access still requires approval if your conversation's plan said network was off-limits — and approving once flips the plan permanently for that conversation, so you're not re-prompted on every subsequent network call.
