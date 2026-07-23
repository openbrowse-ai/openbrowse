---
"openbrowse": patch
---

**Add an "Open in new tab" action to the Space file viewer.**

The file viewer's header now offers an "Open in new tab" button (next to Download) when viewing a Space's workspace file. Clicking it pops the file out into a dedicated `file.html` tab that renders the same `FileViewerPanel` full-screen, so large files, PDFs, sheets, HTML previews, and code can be read without the constraints of the side rail.

- `components/files/FileViewerPanel.tsx` — new optional `openInNewTab` prop. When set, renders an `ExternalLink` icon button that calls `chrome.tabs.create` with `file.html?path=<opfs-path>&name=<file-name>`. Off by default, so conversation-file surfaces are unchanged. Because OPFS is scoped to the extension origin and shared across every extension page, the new tab reads the exact same file by path — no blob handoff across contexts is needed.
- `entrypoints/file/` — new standalone tab entrypoint (mirrors the artifact tab). `main.tsx` reads `path`/`name` from the query string, applies the app theme via `useTheme`, and mounts `FileViewerPanel` with `onClose={() => window.close()}`. It intentionally omits `openInNewTab` so the standalone tab doesn't offer to re-open a copy of itself.
- `entrypoints/_shared/components/LandingPage.tsx` and `RightRail.tsx` — pass `openInNewTab` at the three Space workspace-file viewer call sites (xl rail, stacked rail, and the sidebar rail).
