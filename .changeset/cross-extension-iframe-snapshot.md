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
