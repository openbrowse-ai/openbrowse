---
"openbrowse": patch
---

**Fix `clickElement` stalling indefinitely when chatting from home / new tab, and lift Chrome's background-tab throttling on every worked tab.**

When the user submitted a message from `home.html` or `newtab.html`, the agent's `clickElement` tool would freeze in the "pending" state until the user manually switched to the tab the agent was working on — at which point the click would finally complete and the agent would resume. Root cause: `viewport.waitForLayoutFlush` issued an in-page `await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))` via CDP `Runtime.evaluate { awaitPromise: true }`, and Chrome throttles `requestAnimationFrame` to ~1 Hz then 0 Hz on backgrounded tabs. The intended `timeout: 1000` field on `Runtime.evaluate` is silently dropped by Chrome (the field exists for `Runtime.callFunctionOn`, not `Runtime.evaluate`), so the await actually had no bound — the click pipeline hung until rAF fired again, which only happened when the tab became visible.

Fixed at three layers, complementary not redundant:

- `cdp-session.attach` now issues `Emulation.setPageVisibilityOverride { visibility: "visible" }` and `Page.setWebLifecycleState { state: "active" }` on every CDP-attached tab. The page sees `document.visibilityState === "visible"`, so Chrome stops throttling rAF, `setTimeout`, and the lifecycle freeze that bites long-running background tabs. Both calls are best-effort (some targets reject the override) and need no detach reciprocal — Chrome resets them when the debugger detaches.
- `viewport.waitForLayoutFlush` now races the `Runtime.evaluate` call against a host-side 1500 ms `setTimeout`. Even if the visibility override doesn't take effect for some reason (Chrome version regressing the override, page using `requestPostAnimationFrame`/compositor timeline that's compositor-paused), the click pipeline can never wedge — proceeding with a slightly-stale layout read is strictly better than hanging. Drops the misleading unused `timeout: 1000` CDP field.
- `capture-utils.captureScreenshot`'s `-32000 Unable to capture screenshot` retry path now flips `captureBeyondViewport: true` for the second attempt (when not already set). The off-screen renderer path doesn't depend on a fresh compositor frame, so it succeeds on tabs whose compositor has paused — the dominant `-32000` cause in production. Retry without the 600 ms wait in this case (the wait only helped the legacy "renderer mid-paint" race, not compositor pause).

Net effect: agent tools (clickElement, screenshot, executeOnPage with in-page awaits, CUA loop captures) all run at foreground speed on backgrounded worked tabs, no matter which surface the user is chatting from.
