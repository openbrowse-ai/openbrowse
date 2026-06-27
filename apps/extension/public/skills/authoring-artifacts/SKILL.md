---
name: authoring-artifacts
description: Use whenever the user asks to build an artifact, a dashboard, a widget, or an interactive HTML tool/app they can open as a tab or pin in chat ("make me a tool that…", "build a dashboard for…", "an app that shows…"). Guides authoring a working, error-free artifact and installing it via create_artifact, including how to verify it BEFORE creating it.
---

# Authoring Artifacts

Build a small standalone HTML+JS app — an *artifact* — and install it with
`create_artifact`. This skill is the authoritative reference for everything an
artifact needs: the `window.openbrowse` host API, the styling/theming contract,
the allowed CDNs, the tool/network/storage rules, the authoring workflow, and
how to verify it.

The golden rule: **verify the artifact actually works — both the logic before
you create it, and the running artifact after.** Run the core logic against real
data first; then, after `create_artifact`, confirm it loaded with
`read_artifact_diagnostics` before telling the user it's ready. Never claim
success just because `create_artifact` returned — that only means the file was
saved, not that it runs.

## Host API reference

Inside the artifact's HTML, the host injects `window.openbrowse`:

- `await openbrowse.callMcpTool("mcp.<server>.<tool>", args)` — calls an MCP
  tool listed in `tools[]`. Use the connector id for `<server>` (e.g.
  `mcp.linear.list_issues`, `mcp.github.search_issues`), NOT a random server
  UUID. The host resolves the connector id to whichever server the user has
  connected.
- `await openbrowse.runTool("browser.<tool>", args)` or `"system.<tool>"` —
  calls a browser/system tool listed in `tools[]`.
- `await openbrowse.kv.get(key)` / `kv.set(key, value)` / `kv.delete(key)` /
  `kv.keys()` — persistent per-artifact storage.
- `await openbrowse.network.fetch(url, init?)` — brokered fetch (returns a real
  `Response`). Use this INSTEAD of `fetch()` for cross-origin requests; it
  bypasses CORS by running in the extension. Only hosts listed in `network[]`
  are reachable. All methods allowed; cookies are not sent unless you pass
  `credentials: "include"`.
- `openbrowse.theme` — `{ mode: "light"|"dark", vars: { "--ob-bg", "--ob-fg",
  "--ob-muted", "--ob-accent", "--ob-border", "--ob-card" } }`. Style the
  artifact with these CSS variables so it looks right in both modes.
- `openbrowse.onThemeChange(cb)` — subscribe to light/dark changes; `cb(theme)`
  receives the same shape as `openbrowse.theme`. Re-apply your CSS vars here so
  the artifact stays in sync (the theme can arrive after first paint). Returns
  an unsubscribe fn.
- `openbrowse.artifact` — `{ id, title, mode: "tab"|"card" }`. Render compactly
  when `mode === "card"`.
- `openbrowse.setCardHeight(px)` — when in card mode, request a height (clamped
  to 480 max).
- `openbrowse.toast(message, { type })` — surface status to the user.
- `console.log/info/warn/error` (and `openbrowse.log(level, ...args)`) —
  forwarded to the host devtools console, prefixed with the artifact id, and
  captured for `read_artifact_diagnostics` so you can read them after creating
  the artifact. Use these to debug; the iframe's own console is not otherwise
  visible.

### Styling and theming

There is no CSS framework, Tailwind, or shadcn CSS inside the artifact iframe —
inline all your own CSS. The host injects six CSS variables on `<html>` and
toggles a `.dark` class:

- `--ob-bg` (background), `--ob-fg` (foreground text), `--ob-muted` (muted
  text), `--ob-accent` (primary/accent), `--ob-border`, `--ob-card`.

Reference them directly, e.g. `body { background: var(--ob-bg); color:
var(--ob-fg); }`. The values are full color strings (`oklch(...)`), usable
as-is — do not wrap them. Key off the `.dark` class for any mode-specific
tweaks. The theme can arrive *after* first paint, so don't rely on a one-time
`openbrowse.theme` read alone — also subscribe via `onThemeChange` and re-apply.
Fonts must be data URIs (`font-src data:`) and images data/blob URIs; external
stylesheets are not allowed (only `style-src 'unsafe-inline'` + approved CDNs).

### Network, storage, and tool modes

- You **cannot** use `fetch()` to arbitrary URLs from inside an artifact (the
  sandbox's opaque origin makes most cross-origin requests CORS-fail). Use
  `openbrowse.network.fetch` instead, and list each hostname in `network[]` (no
  scheme, no path; `*.example.com` wildcards allowed). The user approves these
  hosts on install.
- Use `localStorage` only for ephemeral view state (it is wiped on reload).
  Persistent state must use `openbrowse.kv`.
- Each tool entry in `tools[]` declares `mode: "read" | "write"`. Reads run
  silently; writes require user approval at install time. Choose `mode` based on
  what the tool does (`search_/list_/get_` → read; `create_/update_/delete_` →
  write).

### Allowed CDNs

The host does NOT inject any `<script>` tags. To use a library, (1) list its key
in `cdns[]` (which allowlists that CDN's **origin** in the iframe CSP) AND (2)
write the `<script>` tag yourself in the HTML, using the exact pinned URL and
`integrity` below. Always include `integrity` and `crossorigin="anonymous"`.

The CSP allowlists the origin only — it does not verify the hash. Including the
`integrity` attribute is what makes the browser's Subresource Integrity check
reject a tampered or swapped file, so copy it exactly. Loading the pinned URL
*without* `integrity` would still pass the CSP but lose that protection.

- `chartjs@4.5` — Chart.js:
  `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js" integrity="sha384-XcdcwHqIPULERb2yDEM4R0XaQKU3YnDsrTmjACBZyfdVVqjh6xQ4/DCMd7XLcA6Y" crossorigin="anonymous"></script>`
- `gridjs@5.0.2` — Grid.js:
  `<script src="https://cdn.jsdelivr.net/npm/gridjs@5.0.2/dist/gridjs.umd.js" integrity="sha384-/XXDzxe4FsGiAe50i/u9pY/Vy/uX654MHB1xoc1BJNnH1WXHhqHga9g3q5tF4gj7" crossorigin="anonymous"></script>`
- `mermaid@11.10` — Mermaid:
  `<script src="https://cdn.jsdelivr.net/npm/mermaid@11.10.0/dist/mermaid.min.js" integrity="sha384-PY+AFiXLIHkR5jE4nk0JwPQQmmQlT4mJXFlgeT4jJeuARaBQBK+nSwwxzrPRAtUM" crossorigin="anonymous"></script>`
- `d3@7` — D3:
  `<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js" integrity="sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i" crossorigin="anonymous"></script>`

Only these four are available. Any other `cdns[]` key fails `create_artifact`
validation. The CSP then permits scripts from the allowlisted CDN origins
(e.g. `cdn.jsdelivr.net`); a script from any other origin is blocked. Pin the
exact URLs above and keep their `integrity` attributes — that's what guarantees
you get the reviewed file and not some other path on the same CDN.

## Workflow

1. **Confirm the data and tools are real.** For every MCP/browser/system tool
   the artifact will call, call it ONCE yourself in this conversation first and
   read the actual response shape. Never code against an imagined schema. If
   the artifact fetches a URL, fetch it now (via `executeCode` /
   `executePython` / `webFetch`) and inspect the real payload — status,
   content-type, and the exact fields/markup you'll parse.

2. **Verify the core logic against real data — before writing the HTML.**
   This is the step that prevents "it had errors when it loaded." Take the
   actual response from step 1 and run your parsing/transform/render logic over
   it in `executeCode` (or `executePython`). Confirm it produces the values you
   expect (right number of rows, fields populated, dates parsed, etc.). If the
   logic is wrong, you find out HERE — cheaply — not after install. Examples:
   - RSS/HTML scraping: parse the real bytes and log the item count and the
     first item's fields. If you get 0 items or `[object Object]`, the parse is
     wrong — fix it before proceeding.
   - JSON API: assert the fields you'll display actually exist on the real
     response.
   - A computation/chart: feed it the real numbers and check the output.

3. **Author the HTML and create the artifact.** Inline all CSS and JS. Use only
   the allowed CDNs. Port the *exact* logic you just verified in step 2 — don't
   rewrite it from memory. Before creating, skim the Common pitfalls list below
   (most "errors on load" come from it). Call
   `create_artifact({ id, title, icon, html, tools, cdns?, network? })` with
   the HTML inline in `html` (preferred — keeps authoring and verifying in one
   place). **`icon` is required**: pick a single emoji that visually represents
   what the artifact does (📈 for charts, 🐛 for issue triage, 🌦 for weather,
   📦 if you genuinely can't think of anything better). The emoji is shown as
   the favicon of the artifact's standalone tab and as the glyph in artifact
   lists, and the user can change it later from the tab header. The tool
   returns an `artifactId` and an `openUrl`, and the artifact begins running
   in an inline preview in the chat.

4. **Verify it actually ran — do NOT claim success yet.** Creating the artifact
   only saves the file; it does not mean the artifact works. Call
   `read_artifact_diagnostics({ artifactId })`. Interpret the result:
   - `rendered` is non-null **and** `errors` is empty → the artifact loaded and
     painted without throwing. Now you may tell the user it's ready.
   - `errors` is non-empty → read each error, then fix with
     `update_artifact({ id, edits: [{ find, replace }] })` and call
     `read_artifact_diagnostics` again. Repeat until clean. The inline preview
     reloads automatically after each update.
   - `rendered` is null after the wait (and no errors) → the inline preview
     likely didn't mount (e.g. the chat scrolled away). Retry the read once; if
     still null, ask the user to scroll to the artifact card in the chat and
     tell you whether it rendered.

   Also scan the returned `console` output: a successful render with a logged
   error message (e.g. "Couldn't load stories: 0 items") still means the
   artifact is broken — fix it. This is why step "Make failures loud" matters.

5. **Only after a clean verification, tell the user it's ready.** The artifact
   is already running in the chat preview; they can also open it as a tab.

## Make failures loud, never silent

The worst artifact bug is one that hides its own failure. A `try/catch` that
swallows an error and shows "No results" looks identical to "the feature
works but there's genuinely nothing." Always:

- On any fetch/parse/tool error: render a short, visible error message in the
  artifact UI (what failed + why), AND `console.error(...)` the details so they
  reach the host console.
- Distinguish empty-but-OK ("No stories today") from broken ("Couldn't load
  stories: 0 items parsed — feed format may have changed"). If you can't tell
  them apart, treat it as an error and surface it.
- Log a one-line `console.info` at each major step (fetched N bytes, parsed M
  items, rendered M rows) so the host console tells the story when something
  goes wrong.

## Common pitfalls (check every one before promoting)

- **Coding against an imagined schema.** You skipped steps 1–2. Don't.
- **Raw `fetch()` to a cross-origin URL.** It CORS-fails in the sandbox. Use
  `openbrowse.network.fetch` and list every hostname in `network[]`.
- **Forgetting a host in `network[]`.** A redirect to another host (e.g.
  `feeds.example.com` → `cdn.example.com`) needs BOTH hosts allowlisted, or
  use a `*.example.com` wildcard.
- **Reading a brokered response as JSON when it's text/binary** (or vice
  versa). Match how you read the body to the real content-type from step 1.
- **Theming.** Style with the injected `--ob-*` CSS variables (and the
  `.dark` class the host sets) so the artifact matches light/dark on load. If
  you read `openbrowse.theme` once at startup, also subscribe with
  `openbrowse.onThemeChange(cb)` and re-apply — the theme can arrive *after*
  first paint, so a one-time read alone leaves the artifact mis-themed.
- **Persisting state in `localStorage`.** It's wiped on reload. Use
  `openbrowse.kv` for anything that must survive.
- **Card mode ignored.** When `openbrowse.artifact.mode === "card"`, render
  compactly and call `openbrowse.setCardHeight(px)` so the inline preview fits.
- **Silent empty states.** See "Make failures loud" above.

## Updating an artifact

Use `update_artifact({ id, edits: [{ find, replace }] })`. The current HTML is
provided to you in the conversation context when editing — make small, exact
find/replace edits (each `find` must occur exactly once); do not re-send the
whole file. Omit `edits` to change only manifest fields (title, tools, network,
cdns). Adding a new write tool or network host resets the user's approval, so
mention that when it happens. After an edit, the inline preview reloads — call
`read_artifact_diagnostics({ artifactId })` again to confirm the fix worked.

## Quality checklist

- [ ] `icon` is a single emoji that fits what the artifact does.
- [ ] Every tool in `tools[]` was called once and its real shape confirmed.
- [ ] The core parse/transform/render logic was run over REAL data and
      produced the expected output — before writing the HTML.
- [ ] No raw `fetch()`; all cross-origin hosts (incl. redirect targets) are in
      `network[]`.
- [ ] Failures are visible in the UI and `console.error`'d; empty-but-OK is
      distinguished from broken.
- [ ] Themed via `--ob-*` vars + `onThemeChange`; compact in card mode.
- [ ] Persistent state uses `openbrowse.kv`, not `localStorage`.
- [ ] After `create_artifact`, ran `read_artifact_diagnostics`: `rendered` is
      non-null, `errors` is empty, and no error is logged in `console` — THEN
      told the user it's ready.
