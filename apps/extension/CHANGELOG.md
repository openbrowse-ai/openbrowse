# openbrowse

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
