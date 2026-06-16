---
"openbrowse": patch
---

Tab identity continuity via `LogicalTabId` and `TabRegistry`.

The extension now keys agent-facing tab handles, conversation ownership, and persisted state on stable `LogicalTabId`s (UUIDs) instead of `chrome.tabs.id` (which Chrome silently renumbers on prerender activation, BFcache restore, and some discard/restore paths). A new `tab-registry` module owns the only `chrome.tabs.onReplaced` listener in the codebase and consolidates the trailing `onRemoved` Chrome fires for the replaced ctid (so consumers see exactly one event, not a replace-then-remove pair).

Symptoms this fixes in production:

- "Unknown tab handle" mid-flow on Speculation Rules sites (Attio settings, Notion, Vercel, Google Search, X) where prerender activation renumbers the underlying tab id.
- "Cannot attach debugger to tab N: No tab with given id N" loops in the CUA computer-use subagent, which previously cached the chrome ctid at loop start and never refreshed it.
- Stale `chrome.tabs.id` recycling across Chrome restarts that could resolve a persisted handle to an unrelated user tab.
- `waitForTabLoad` timing out when the navigation completed on the post-replace ctid rather than the pre-replace one.

chatDb schema bumps to v15. The migration walks each conversation's legacy `ownedTabIds: number[]`, probes `chrome.tabs.get(ctid)` to confirm liveness, and rewrites surviving entries through the registry to `ownedLtids: string[]`. Dead ctids are dropped silently; corrupt rows degrade to empty owned-state with a `console.warn` rather than aborting the upgrade. The `handleState.handles` map is rewritten in the same pass.

The CUA loop subscribes to the registry's `onReplace` event and updates its cached ctid in place, keeping long-running computer-use sessions alive across prerender activations. The working-overlay glow re-routes to the new ctid automatically so the user sees continuous feedback.
