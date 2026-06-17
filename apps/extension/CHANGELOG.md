# openbrowse

## 0.9.2

### Patch Changes

- b7c3e10: Make CDP frame-walking calls (`Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`) resilient to cross-extension iframes that the debugger isn't permitted to inspect.

  Symptoms this fixes:

  - "Cannot attach debugger to tab N: No tab with given id N" cascading across every action on http(s) pages where another installed Chrome extension (e.g. **1Password**, LastPass, Bitwarden, Honey, Grammarly) has injected a content-script iframe served from `chrome-extension://<otherExtId>/`. Chrome refuses cross-extension debugger access and detaches the whole session as collateral, which made every snapshot fatal until the page was closed.
  - Misleading `No tab with given id` errors that read like a prerender / Speculation Rules failure (handled separately by #139) but were actually caused by a hostile iframe.
  - Repeated "post-action snapshot failed" warnings on sites with many embedded forms where a password manager aggressively injects.

  What changed:

  - New `isCrossExtensionFrameError` classifier in `cdp-errors.ts`. The detach classifier (`isDetachError`) explicitly does NOT match this class, so the existing detach-and-retry path can never accidentally tear down a healthy session for a per-call iframe failure.
  - `cdp-session.ts` bails early on cross-extension errors at both catch sites (`<Domain>.enable` and the actual command). The session is left intact; the error bubbles to the caller.
  - `snapshot-capture.ts` adopts a two-tier AX-walk strategy:
    - **Tier 1 (primary)**: a single whole-tree `Accessibility.getFullAXTree()` call. Chrome stitches the AX tree across frames on its end, preserving legitimate iframe content (Stripe, YouTube, embedded forms, etc.). On benign pages and on most pages that have a foreign extension iframe loaded but not actively in the AX walk, this is the only CDP round-trip taken — no additional cost vs. the legacy code.
    - **Tier 2 (fallback, only on cross-extension rejection)**: `Page.getFrameTree` to enumerate frames, then `Accessibility.getFullAXTree({frameId: <main>})` to walk just the main frame. Legitimate child-frame content is unavailable in this mode; the agent is told via `note`.
  - `buildTree` returns a synthetic empty root when given zero AX nodes (instead of dereferencing `nodes[0]`), so an all-frames-hostile page produces an empty snapshot rather than crashing.
  - New `note` field on `CaptureResult`, propagated through `snapshot`, `clickElement`, `typeInElement`, `pressKey`, and `navigate`. When frames were excluded the agent receives a short, agent-actionable message naming the offending extension hosts. The note language is split into two cases so attribution is honest:
    - Foreign-only exclusions: lists the cross-extension hosts and confirms the main page is unaffected.
    - Raced/main-frame failures: reports "frames errored mid-walk" without speculating about which extension owns them, and recommends a retry.

  Tests added:

  - `cdp-errors.test.ts` — classifier coverage on every Chrome error string we've seen in the wild + the mutual-exclusion invariant against `isDetachError`.
  - `cdp-session-cross-extension.test.ts` — confirms the session map is NOT mutated and no retry runs when a cross-extension error fires from either `<Domain>.enable` or the command itself.
  - `snapshot-capture-cross-extension.test.ts` — Tier 1 happy path (no frame-tree round-trip), legitimate child-frame content preserved across the merge, Tier 2 fallback semantics (main-frame-only walk, no other safe frames walked, attribution note correct), soft language when the main frame itself races, and the generic note when `Page.getFrameTree` is unavailable post-rejection.

- 5b07aa6: Data plumbing: `saveAs` on `executeOnPage`/`executeCode`, atomic workspace writes, removed `executePython`'s `input` parameter.

  Three execution sandboxes in the extension (`executeOnPage`, `executeCode`, `executePython`) share no filesystem — they're each in different origins, and only `executePython` has access to `/workspace` (the conversation's OPFS). The agent had no first-class way to move bytes between them, so it would route data through chat context: a tool returns a string, the agent sees it, the agent calls another tool with the string as an argument. For payloads larger than a few KB this bloats context, triggers truncation, and pushes the agent into ad-hoc transports (chunk-and-stitch, base64, browser downloads, CORS proxies). One real chat hit 30+ tool calls trying to move a 62 KB JSON between `executeOnPage` and `executePython`.

  This change adds a `saveAs: "<path>"` parameter to both `executeOnPage` and `executeCode`. When set, the script's return value is written directly to `/workspace/<path>` by the host, and the tool result is `{ path, bytes, sha256 }` (plus `tab` or `logs`) instead of the data — so the bytes never enter chat context. Strings are written as text; binary content uses the envelope `{ __binary_b64: "..." }`. Writes go through new `OPFS.writeFileAtomic` / `writeFileBytesAtomic` helpers that stage to a `<path>.tmp-<rand>` sibling, so a producer crash mid-serialize never truncates a previously-good file.

  Companion: removed `executePython`'s `input` parameter. Its description ("JSON-encoded data made available as the Python global `__input`") read like the canonical channel for passing data into Python, but the parameter only worked for small JSON-shaped payloads and silently failed on `JsProxy` values, which sent agents into spirals when they mistook it for the right transport. With `saveAs` and the existing `Write` + `/workspace` path, `input` was redundant. Skills that referenced it (`python-env`, `csv-to-markdown` in `writing-skills`) have been updated to the file-based pattern.

  New `data-plumbing` skill documents the canonical recipes (page → /workspace → Python), the three-sandbox model, anti-patterns from past failures, and recovery moves. Loaded by trigger phrases like "scrape this page", "build a CSV", "save the JSON".

  Sandbox 1 MB JSON-output cap is bypassed when `saveAs` is set — the cap exists to protect chat context, but `saveAs` already does that more directly.

## 0.9.1

### Patch Changes

- e085675: Tab identity continuity via `LogicalTabId` and `TabRegistry`.

  The extension now keys agent-facing tab handles, conversation ownership, and persisted state on stable `LogicalTabId`s (UUIDs) instead of `chrome.tabs.id` (which Chrome silently renumbers on prerender activation, BFcache restore, and some discard/restore paths). A new `tab-registry` module owns the only `chrome.tabs.onReplaced` listener in the codebase and consolidates the trailing `onRemoved` Chrome fires for the replaced ctid (so consumers see exactly one event, not a replace-then-remove pair).

  Symptoms this fixes in production:

  - "Unknown tab handle" mid-flow on Speculation Rules sites (Attio settings, Notion, Vercel, Google Search, X) where prerender activation renumbers the underlying tab id.
  - "Cannot attach debugger to tab N: No tab with given id N" loops in the CUA computer-use subagent, which previously cached the chrome ctid at loop start and never refreshed it.
  - Stale `chrome.tabs.id` recycling across Chrome restarts that could resolve a persisted handle to an unrelated user tab.
  - `waitForTabLoad` timing out when the navigation completed on the post-replace ctid rather than the pre-replace one.

  chatDb schema bumps to v15. The migration walks each conversation's legacy `ownedTabIds: number[]`, probes `chrome.tabs.get(ctid)` to confirm liveness, and rewrites surviving entries through the registry to `ownedLtids: string[]`. Dead ctids are dropped silently; corrupt rows degrade to empty owned-state with a `console.warn` rather than aborting the upgrade. The `handleState.handles` map is rewritten in the same pass.

  The CUA loop subscribes to the registry's `onReplace` event and updates its cached ctid in place, keeping long-running computer-use sessions alive across prerender activations. The working-overlay glow re-routes to the new ctid automatically so the user sees continuous feedback.

## 0.9.0

### Minor Changes

- 8959f4d: Surface the agent's plan, workspace files, and context in the side panel, and
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

### Patch Changes

- 8ae2bd0: Fix agent clicks being silently eaten by OpenBrowse's own "is working" overlay,
  and replace post-action diffs with viewport snapshots.

  Trusted CDP `Input.dispatchMouseEvent` events the agent dispatched were landing
  on `.ob-cua-root` — the full-viewport (`position:fixed; inset:0`) shadow-DOM
  wrapper inside the `openbrowse-cua-working-host` overlay — which had implicit
  `pointer-events: auto`. Because hit-testing climbs from a `pe:none` shield to
  its parent, the click never reached the page element underneath. Symptoms
  included FAQ accordions never expanding after `clickElement`, theme toggles
  that reported success but didn't flip, and CUA subagent clicks landing on
  nothing. Adding `pointer-events: none` to `.ob-cua-root` lets descendants with
  explicit `pe:auto` (the shield, the Stop button) keep working as hit-test
  targets while letting the agent's own dispatches pass through to the page.

  Also: `clickElement` / `typeInElement` / `pressKey` now auto-attach a fresh
  viewport-scoped accessibility snapshot in their response (replacing the legacy
  `diff` field). The diff approach hallucinated when the prior snapshot was
  viewport-scoped and the post-action capture defaulted to full-tree — the model
  saw every below-fold element as `[+] added`. The new shape is strictly more
  informative: the model can pick its next ref directly from the post-action
  state without a follow-up `snapshot` call. The `snapshot` tool keeps its
  opt-in `diff: true` mode for callers that want it.

  The click ripple now matches the active space tint, doubles in size, and uses
  a layered "dithered shockwave" animation (halo + dithered disc + 2 parallax
  rings + center spark) so the live tab gives clearer feedback when the agent
  clicks.

- 4854b5a: Fix Anthropic/Opus `tool_use.input: Field required` from failed tool calls.

  A terminal failed tool call (e.g. a failed MCP "Updated list entry") whose
  input was never captured was replayed on the next turn as a `tool_use` block
  with no `input`. Anthropic rejected the request with `tool_use.input: Field
required` (a visible "Something went wrong"); Gemini coerced it, so the bug
  only reproduced on Opus. The send-time heal now drops these input-less errored
  and denied calls before they reach the provider, while keeping any call that
  has a real input or a partial `rawInput` (which the SDK fills in).

- b1a17e4: Keep Attio/Stripe (and other OAuth) connectors authorized across extension
  updates.

  OAuth connectors were registered for the `authorization_code` grant only, so
  providers refused the later `refresh_token` token call — meaning an expired
  access token (e.g. after the service worker restarts on an extension update)
  could not be renewed silently and the connector fell back to "needs
  re-authorization". Now we register for the `refresh_token` grant too and
  request `offline_access` when the provider supports it (including providers
  like Stripe that publish no scope list but do advertise the refresh grant). An
  interactive re-auth also re-registers, repairing connectors stored by older
  builds without removing and re-adding them. Connectors whose tokens are
  long-lived (e.g. Supabase) are unaffected.

## 0.8.1

### Patch Changes

- 31d6205: Fold completed tool calls into a "Completed N steps" collapsible.

  While tools are running they stay expanded and live; once the assistant
  begins its answer text, a run of 3+ tool calls auto-folds into a
  collapsible labeled "Completed N steps" (click to re-expand), matching
  the Perplexity Comet pattern. Runs of 1-2 tools, reasoning-only groups,
  and pending approval prompts render inline as before.

- 31d6205: Fix interrupted tool calls breaking the next request.

  A tool call aborted before its arguments finished streaming was replayed
  on the next turn as a `tool_use` block with no `input`, which providers
  reject — Anthropic/Bedrock with `tool_use.input: Field required` (a
  visible "Something went wrong" error) and Gemini/Vertex with a silent
  malformed-function-call error that just stopped the generation. The
  send-time heal now drops these input-less interrupted calls before they
  reach the provider, so the conversation can continue.

## 0.8.0

### Minor Changes

- 11fa134: Add a Computer Use (CUA) subagent that lets Anthropic Claude models drive the live browser tab. Includes a provider-neutral CUA loop (canonical actions, CDP executor, coordinate mapping, screenshot zoom) with the Anthropic provider wired in, a computer-use capability flag and model picker in Settings, AI Gateway transport support, content-stable element refs, a working-on-page overlay with stop/abort, and in-place retry that continues an errored assistant turn.

## 0.7.2

### Patch Changes

- 4c11faa: Prevent multiple open tabs from auto-restarting the same agent run, and
  mirror live agent progress across tabs.

  - Disable message-load auto-resume (it made every open context restart
    the same run).
  - Add an atomic per-conversation ownership lock so only one context
    drives a run.
  - Stream full-message snapshots to other tabs as read-only viewers;
    approvals and stop are forwarded to the owner.

## 0.7.1

### Patch Changes

- 2e0bd8a: Fix extension update resilience (spaces and MCP refresh), tool state UI, and tool healing validation

## 0.7.0

### Minor Changes

- ab6a7ec: Add a `/compact` slash command to the chat composer. Typing `/` now lists
  built-in commands (under a "Commands" group) alongside skills; selecting
  `/compact` manually compacts the conversation — summarizing the full history
  and sending only that summary to the model on the next turn, while the UI
  keeps showing every original message. Supports "compact-then-send" (`/compact
<text>` compacts, then sends the remaining text) and surfaces a toast for every
  outcome (compacted, too short, or failure).

  Also fixes the compaction model resolution so it correctly handles the stored
  `provider:model` key (previously it failed to find a provider, which silently
  broke both manual and automatic compaction).

## 0.6.0

### Minor Changes

- 4630aed: Add a context-usage indicator to the chat header: a circular progress ring that shows tokens, usage %, and cost on hover, and a detailed breakdown (provider/model, context limit, token split, total cost, timestamps) on click.
- 67c8be2: Add scheduled tasks: recurring, cron-like agent runs that execute as full
  background agent sessions (DOM + chrome.debugger, system prompt, compaction).
  Driven by a bundled `/schedule` skill and `create/list/update_scheduled_task`
  tools, with a Scheduled dashboard, create/edit dialog, status badges, and a
  per-task auto-approve toggle.

### Patch Changes

- 2965aed: Fix chat input lag in long conversations. The message list is now memoized and
  extracted from the input's render path, so typing no longer re-renders every
  message (markdown + syntax highlighting) on each keystroke.

## 0.5.3

### Patch Changes

- 6f47a91: Show subagent-opened tabs in the Context card with a "Subagent" badge and
  grouped cleanup, sort sidebar chats by creation time, and open new agent tabs
  in the conversation's own window instead of whatever window Chrome has focused.
  Also fixes the Stripe MCP connector endpoint (404).

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
