---
"openbrowse": patch
---

**The command palette no longer scrolls its own search input out of view.** The palette is an iframe whose height the host sets from the palette's measured content, clamped to 70% of the viewport. With enough tabs, chats, and commands to render, the content outran that clamp, the iframe document itself became scrollable, and any `scrollIntoView` — including the one that fires when you merely _hover_ a row, since hover sets the focused index — dragged the whole palette up until the search input was off-screen.

- **The host now tells the palette its height budget** (`OPENBROWSE_OVERLAY_VIEWPORT`, answered on a palette `HELLO` and re-sent on host resize) from all three hosts: the page content script, `HomeApp`, and `useOverlay`. The palette can't derive this itself — on a web page the host is a different origin, and `100vh` _inside_ the iframe means "the height the host already gave us", which would freeze the auto-size loop at whatever height the palette opened with.
- **The palette fits itself to that budget** instead of overflowing: header, auto-tidy banner, scope bar, and footer are `shrink-0`, and the view-switching middle is the one region that shrinks, so the search input and footer stay pinned no matter how many results are listed. Long forms (configure space, color picker) scroll inside that region.
- **Row-focus scrolling is scoped to its own list.** `scrollIntoView` walked every scrollable ancestor; the replacement only ever adjusts the nearest scroll container's `scrollTop`, so nothing above the list can move — and hovering an already-visible row now scrolls nothing at all.

**Test surface.** +18 unit tests (`lib/overlay-frame.test.ts` for the height-budget handshake and its floor-vs-clamp agreement, `overlay/scroll.test.ts` for the scoped scroll math). All 3,158 tests pass; `tsc --noEmit` clean.
