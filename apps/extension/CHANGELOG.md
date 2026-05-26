# openbrowse

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
