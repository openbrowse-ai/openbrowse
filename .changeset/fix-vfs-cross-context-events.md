---
"openbrowse": patch
---

**Fix stale file/memory views when another extension context writes to OPFS.**

`emitVfsChange` only reached listeners inside the JS context that performed the write. Since agent runs execute in the MV3 service worker while the UI lives in extension pages, a Settings > Memory tab (or any open file viewer) kept rendering whatever it read on mount — the agent could author `memory/**` mid-run and the tab would still show the old tree and old file contents until reload.

- `vfsEvents` is now bridged across same-origin extension contexts over a `BroadcastChannel`, so a write from the service worker, the sidepanel, or another tab re-emits `vfs:change` everywhere. Subscribers are unchanged — they still just listen on `vfsEvents`.
- The memory browser, the memory frontmatter header, and the file viewer additionally re-read on `visibilitychange`, a catch-up for a background tab that was frozen or throttled when the broadcast went out.
- A memory write now emits a second `vfs:change` after `syncPath` lands the index row. The `OPFS.*` emit fires _before_ reindexing, so a surface rendering parsed frontmatter would otherwise read the previous row; subscribers debounce, so the two emits coalesce into one refresh.
- A same-file text reload in `FileViewerPanel` now swaps content in place instead of blanking the pane first, so a live-updating file no longer flashes on every write.
