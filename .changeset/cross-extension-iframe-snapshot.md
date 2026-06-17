---
"openbrowse": patch
---

Make CDP frame-walking calls (`Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`) resilient to cross-extension iframes that the debugger isn't permitted to inspect.

Symptoms this fixes:

- "Cannot attach debugger to tab N: No tab with given id N" cascading across every action on http(s) pages where another installed Chrome extension (e.g. **1Password**, LastPass, Bitwarden, Honey, Grammarly) has injected a content-script iframe served from `chrome-extension://<otherExtId>/`. Chrome refuses cross-extension debugger access and detaches the whole session as collateral, which made every snapshot fatal until the page was closed.
- Misleading `No tab with given id` errors that read like a prerender / Speculation Rules failure (handled separately by #139) but were actually caused by a hostile iframe.
- Repeated "post-action snapshot failed" warnings on sites with many embedded forms where a password manager aggressively injects.

What changed:

- New `isCrossExtensionFrameError` classifier in `cdp-errors.ts`. The detach classifier (`isDetachError`) explicitly does NOT match this class, so the existing detach-and-retry path can never accidentally tear down a healthy session for a per-call iframe failure.
- `cdp-session.ts` bails early on cross-extension errors at both catch sites (`<Domain>.enable` and the actual command). The session is left intact; the error bubbles to the caller.
- `snapshot-capture.ts` runs a `Page.getFrameTree` pre-pass on every capture and walks each frame individually with `Accessibility.getFullAXTree({frameId})`. Frames whose URL starts with `chrome-extension://` and don't belong to this extension are skipped preemptively; per-frame races (an iframe injected mid-walk) are caught and logged. When `Page.getFrameTree` is unavailable (older Chrome / non-Page targets), the helper falls back to the legacy whole-tree call. `buildTree` now returns a synthetic empty root when given zero AX nodes (instead of dereferencing `nodes[0]`), so an all-frames-hostile page produces an empty snapshot rather than crashing.
- New `note` field on `CaptureResult`, propagated through `snapshot`, `clickElement`, `typeInElement`, `pressKey`, and `navigate`. When frames were excluded the agent receives a short, agent-actionable message naming the offending extension hosts so it knows the snapshot represents the actionable parts of the page even though the walk wasn't whole-tree.

Tests added:

- `cdp-errors.test.ts` — classifier coverage on every Chrome error string we've seen in the wild + the mutual-exclusion invariant against `isDetachError`.
- `cdp-session-cross-extension.test.ts` — confirms the session map is NOT mutated and no retry runs when a cross-extension error fires from either `<Domain>.enable` or the command itself.
- `snapshot-capture-cross-extension.test.ts` — per-frame walking semantics: foreign frames preemptively skipped, race-injected frames caught, nested frames handled, legacy fallback when `Page.getFrameTree` is unavailable.
