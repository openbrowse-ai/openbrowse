---
"openbrowse": minor
---

**Add a `webSearch` agent tool backed by a managed, server-side Exa proxy.**

The agent can now search the web as a fast "find" layer — ranked results with a text excerpt and highlighted snippets — without an API key ever shipping in the (fully inspectable) extension bundle. The key lives only on the server.

- **Hosted proxy (`apps/docs/app/api/search`).** A `POST /api/search` route forwards the query to Exa using a server-side `EXA_API_KEY`, clamps `numResults`, requests text + highlights, normalizes results to only the fields we expose, and applies best-effort per-IP rate limiting. Requires `EXA_API_KEY` in the docs deployment.
- **Extension tool (`webSearch`).** Calls the proxy (localhost in `wxt dev`, hosted in production; override with `WXT_PUBLIC_SEARCH_ENDPOINT`), bounded by a 20s timeout and the agent loop's abort signal. Errors are returned to the model, never thrown. For deep reading or pages behind login, the agent still follows up with `navigate` + `readPage`/`extract`.
- **UI.** Dedicated result renderer plus dynamic status labels (e.g. `Searched "…" — 8 results`).

Registered in the browser tool set and the tool-input-schema test. +5 tool tests.
