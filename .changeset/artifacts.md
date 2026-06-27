---
"openbrowse": minor
---

**Artifacts.** The agent can now build self-contained mini-apps — dashboards, widgets, interactive HTML tools — and you can open them as a tab or pin them in your workspace. Ask for "a tool that…", "a dashboard for…", or "an app that shows…" and the agent writes a single sandboxed HTML+JS artifact, then verifies it actually renders before handing it back.

**Sandboxed runtime.** Artifacts run in an isolated, opaque-origin iframe with no access to your browser, extension storage, or other pages. They reach the outside world only through a small `window.openbrowse` bridge: scoped key/value storage, brokered `fetch` (routed through the extension so artifacts avoid third-party CORS proxies), and the browser/MCP tools you've granted. A per-artifact permission manifest gates network hosts and write-capable tools; expanding that surface re-prompts for your approval. Artifacts follow your light/dark theme automatically.

**Pinned dependencies.** Artifacts may load a small allowlist of pinned libraries (Chart.js, Grid.js, Mermaid, D3) from a trusted CDN; the script tags carry Subresource Integrity hashes so a tampered or swapped file is rejected by the browser.

**Workspace & editing.** New artifacts open in a side-rail viewer with a rendered/source toggle and a live console. Use **Edit this artifact in chat** to revise an existing one — the agent makes surgical edits rather than rewriting the whole file — or **Fix with OpenBrowse** in one click when an artifact throws an error.
