---
"openbrowse": minor
---

**Universal palette search: the ⌥K palette now searches tabs, chats, artifacts, spaces, and commands from one input, with grouped results and scoping.**

The command palette was previously "Search tabs" — a single URL-centric list (open tabs, favorites, bookmarks, history, recently-closed) plus a separate `/`-gated action mode. It now fans a single query out across every kind of thing you've touched, keeps results grouped and scannable, and folds commands in as a first-class group instead of a mode.

What changed:

- **Five result groups from one query.** The tuned URL pipeline is untouched and becomes the "Open & visited" group; new isolated builders add **Chats**, **Artifacts**, **Spaces**, and **Commands**. Groups render in a fixed order (URL results always first), each capped (8/4/4/3/4) with "show more", and empty groups are omitted. Chat/artifact/space matching is metadata-only (title/description/name), scored with the existing `scoreQuery`, so the palette stays synchronous and instant.
- **Dual scoping.** Type a leading token (`chat:`, `art:`/`artifact:`, `space:`, or `/` for commands) or click/`Tab` a group header to narrow to one group; a removable "Filtering" chip reflects the active scope and `Esc`/`Backspace` clears it. `/` is now simply the command scope — the separate action mode is gone, and its now-dead `OverlayActionList`/`SortableSpaceItem` components were removed (the action data + `useFilteredActions` moved to `components/actions.ts`).
- **Commands are first-class.** They surface from any plain query (type "settings" and the command appears) and the full command set shows in the empty-query zero state. The zero state is now Favorites → Recents (recent chats + recent artifacts) → Commands; recently-closed tabs no longer clutter the default view (they still appear when you search).
- **New actions.** Enter opens a chat in a dedicated chat tab (reusing the current tab in extension context), opens an artifact's rendered view in a new tab, or switches to a space. The **"AI chat" command became "New chat"** and opens the chat landing page (new-tab) instead of the side panel; the side panel remains on ⌥I.
- **Data plumbing.** New background endpoints `OVERLAY_LIST_CHATS` / `OVERLAY_LIST_ARTIFACTS` (chat DB + OPFS live in the extension context, not the content-injected overlay), plus `OVERLAY_OPEN_CHAT` / `OVERLAY_OPEN_ARTIFACT`.

UI polish and fixes bundled in:

- **Tab-row drag handle** no longer reserves a column — the grip now appears over the favicon on hover, tightening every row.
- The Home sidebar button is relabeled **"Search"** (it's no longer tabs-only), and the palette placeholder reads "Search tabs, chats, artifacts…  / for commands".
- **⌥K now works on the new-tab page.** The `open-search` command bailed on `chrome://newtab/` before checking for our own pages; it now routes the NTP (and any of our extension pages) to the in-page overlay toggle.
- **`TOGGLE_HOME_OVERLAY` is window-scoped.** `HomeApp` and the settings-page `useOverlay` hook ignore toggles aimed at another window (messages without a `windowId` still broadcast), so ⌥K only toggles the focused window's palette instead of every open home/new-tab instance.
- **`Tidy tabs` / `Clean` work from the palette again.** `execGlobalAction` now passes the overlay's known `windowId` in `OVERLAY_GLOBAL_ACTION`; previously the background couldn't resolve a window from the overlay iframe and these actions silently no-oped.

**Test surface.** +20 unit tests for the palette foundation (`overlay/search/palette.test.ts`: builders, scope-token parsing, grouping/caps/scope, and the `Match → PaletteResult` adapter). All 2,208 tests pass; `tsc --noEmit` clean.
