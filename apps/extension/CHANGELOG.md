# openbrowse

## 0.5.2

### Patch Changes

- 278b9e0: Tune the completion check to reduce false rejections and latency: the
  evaluator now runs as a single fast pass (no tool calls), accepts a
  reasonable interpretation of ambiguous requests instead of looping the
  agent, and no longer rejects page-grounded facts based on its own stale
  knowledge (e.g. "that batch doesn't exist yet").

## 0.5.1

### Patch Changes

- cf239e1: Fix agent completion/approval notification clicks to open the conversation in the tab and window where the agent actually ran, instead of the last-active window (which sometimes spawned a new window).

## 0.5.0

### Minor Changes

- 832e867: Agent can now clean up the tabs it opened: a `closeTabs` tool closes the conversation's tab group (or specific tabs you opened) with a reversible Undo toast, plus manual control over the workspace Context card. Adds a bundled `writing-skills` skill that guides the agent through authoring a new skill and installing it via `create_skill`. Also fixes `closeTabs` being rejected by the Anthropic API (its tool input schema now serializes to a top-level object), which previously broke agent turns on Anthropic models.

## 0.4.3

### Patch Changes

- 7c36ce6: Favorite tabs behave Arc-style: a favorite is recognized by hostname (adopts the first matching open tab, stays recognized while you navigate within the same site, and survives service-worker restarts); reordering favorites in the overlay now moves the real Chrome tabs and keeps them ordered between pinned and regular tabs (with bounce-back on manual reorder, returning a favorite to its own slot). Spaces now reliably reattach to their windows across browser restarts (via a durable home-tab anchor with pinned-tab fallback) instead of losing favorites and spawning new empty spaces; pinned tabs are persisted per space and reopened when a space's window is recreated (favorites are no longer auto-opened). Also: reuse an existing Settings tab instead of opening duplicates; Settings logo no longer navigates; remove Esc-closes-Settings; Models search supports "/" focus and Esc-to-clear with hints; chat-delete dialog keycap styling + optimistic removal; "Send now" on the next queued message; "Continue" action on the chat error banner; overlay footer logo respects dark mode; fix overlay logo/Actions menu close-then-reopen flash; scope the "working on this tab" blocker to the agent's actual tab.

## 0.4.2

### Patch Changes

- 610c535: Aux model picker shows all configured models; token-AND model search; fix approval-interrupt bug; expose executePython; improved MCP approval + skill-install UX.

## 0.4.1

### Patch Changes

- 6010425: Fix tool-approval "Always allow", add other-tab awareness, and assorted abort/UX fixes:

  - Respect "Always allow" by calling `needsApproval` with the AI SDK's positional `input` argument (previously `input` was always `undefined`, so the same-origin allowlist was never consulted and approval was always required).
  - Surface the user's other open tabs to the agent as an awareness-only `## Other open tabs` block. Titles/URLs are sanitized (newlines/control chars collapsed, length-capped) before reaching the system prompt to prevent prompt injection, and only `http(s)` URLs are exposed.
  - Bind the shared active tab on the first message of a new conversation so the legend marks it `[active]` immediately; the bind now honors a `{ ok: false }` background response instead of pinning an unbound tab.
  - Skip the completion check when the user aborts generation (the SDK emits an `abort` chunk and closes cleanly, which previously caused the check to grade an abandoned draft).
  - Stop TipTap from nesting pasted markdown links on each copy/paste/resend cycle.
  - Disable per-word stagger in the markdown renderer to fix concurrent/parallel reveal of streamed sections.

## 0.4.0

### Minor Changes

- dbbda3c: Subagents: the chat agent can now delegate focused tasks to specialized subagents that run with fresh context, their own tool allowlist, and isolated tab/window state.

  - **`explore`** — read-only research subagent. Use for background investigation that should not mutate state.
  - **`general`** — read/write subagent for general-purpose delegation when the parent's tools fit but the work would bloat the parent's context with verbose output.

  Each delegation appears inline as a collapsible trace block with a live transcript, a step counter, and a phase title the subagent updates as it works. Subagents run with isolation: `peer` puts the child in its own tab group within the same window (default), and `incognito` opens a fresh incognito window with no shared cookies/auth/storage that auto-closes when done. Stop now correctly cancels in-flight subagents along with the parent.

## 0.3.2

### Patch Changes

- 402b8d0: Add Attio as a built-in MCP connector (new "CRM" category) with OAuth, all 37 tools, and light/dark icons. Also fixes MCP reliability:

  - OAuth flow now sends a `state` parameter, required by strict providers like Attio (previously failed with "Authorization page could not be loaded").
  - Connected MCP servers are no longer torn down and reconnected on every home.html load — this eliminated a multi-second window where the agent saw zero MCP tools.
  - An active chat conversation now rebinds to the latest transport when MCP tools finish loading, so newly connected tools become available without a refresh.
  - Settings → Connectors left panel border now spans the full height.

## 0.3.1

### Patch Changes

- b5717e9: Fix three small chat issues:

  - Completion check no longer runs while a tool call is paused on human approval. The drafted text at that point is mid-narration ("I'll now run X to do Y") and isn't a final response — the gate now waits for the next iteration after approval, when the tool actually has output.
  - Long tool error logs collapse to ~10 visual lines with an inline expand toggle. Single-line errors that wrapped to dozens of visual lines now collapse correctly (the previous clamp only counted `\n`-delimited lines). Applied to executeCode/executeOnPage/executePython error output, the skill tool's error block, and the top-level chat error banner.
  - "Always allow on <site>" now reliably persists before the agent resumes. The previous implementation fired the storage write and the approval synchronously, so the next tool call's `needsApproval` check could race the write and re-prompt — most reproducible on home.html with back-to-back executeOnPage calls.

## 0.3.0

### Minor Changes

- 2604829: Agent: a separate skeptical evaluator now reviews each drafted final response before it reaches you, and asks the agent to revise if the response is incomplete or unsupported by what was actually observed. Mid-loop refinements show as a compact "Refining answer" pill; unresolved concerns surface as a soft warning. Choose a cheaper or faster evaluator model in Settings → General, or leave it on the default. Chat exports and the per-message Copy button now include the rejection block as part of the audit trail.

### Patch Changes

- 2604829: Agent reliability fixes:

  - Tab handles now persist across mid-stream conversation switches, so in-flight tool calls in the previous chat don't lose the tab they were targeting.
  - Stranded tool calls left over from interrupted streams heal cleanly on edit/retry/regenerate instead of breaking the conversation on resume.
  - Approving a tool call while other tools are still running in the same step no longer drops the auto-resume — the agent now picks up the approved call once the rest of the step completes.
  - Editing a user message in chat-db now logs a warning when the target id can't be found, surfacing the historical "stale tail after edit" failure mode at first repro instead of silently months later.
  - The completion-check evaluator now pins to its transport instance, so multiple concurrent agent windows can't drift across each other's models mid-stream.
  - Evaluator-error fallback messages no longer expose internal error details to the chat or markdown export; detailed errors stay in the developer console.

## 0.2.2

### Patch Changes

- 98f6004: Agent: tab arguments on browser tools are now explicit (`tab: "t1"`) instead of relying on an implicit "active tab". Fixes the "Always allow on this domain" approval button not appearing when the agent acted from the home tab. Conversation tab handles persist across service worker restarts. (#39)

## 0.2.1

- Fixes for rail layout mount and agent-transport compound keys (#24).

## 0.2.0

- Message queueing while the agent is streaming.
- Working-folder viewers, resizable side panel, and OPFS uploads (#21).
- Per-conversation file uploads to OPFS workspace (#18).
- Provider catalog cache invalidation on storage change.

## 0.1.1

- Initial public preview.

> Releases prior to changesets adoption are summarized from the GitHub
> release notes. Future entries will be authored from `.changeset/*.md`
> files attached to each PR.
