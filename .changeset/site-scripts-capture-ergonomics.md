---
"openbrowse": minor
---

OpenBrowse now learns from your browsing. As your agent works through a task, it watches what worked and quietly saves reusable scripts and notes per site (LinkedIn, Luma, X, Notion, etc.) so the next time you're on the same site, the agent picks up where it left off — knowing the page's quirks, where content lives, which API to call. You don't have to do anything; this happens in the background after each successful task.

**See what's happening in the page.** Two new tools, `read_network_requests` and `read_console_messages`, let the agent inspect a page's API calls and JavaScript errors in real time. Useful when you ask it to debug a broken page, find an undocumented API, or scrape data from a site that loads everything via fetch. The agent now also catches when a click "missed" because of an overlay versus when it actually worked but looked like it missed — fewer wasted clicks, fewer redundant retries.

**Faster, more reliable script execution.**

- `executeCode` and `executeOnPage` now save big results straight to your workspace when you ask for it, instead of stuffing JSON into the chat.
- `executeCode` supports modern async/await and a configurable timeout (up to 2 minutes) — handy for batched API calls.
- The agent gets clearer guidance about when to run code in the page (with the page's cookies) versus in a background sandbox (without them) — fewer "Failed to fetch" loops on logged-in sites.
- After saving a file to workspace, the agent now sees that file in its context every turn — so it doesn't forget what it already wrote and re-do the work.
- When the agent loses track of which tab it's working with, the error now lists every open tab right inline — so it recovers instantly instead of asking around.

**Workspace tooling.** A new `Delete` action lets the agent clean up files it no longer needs (with safety rails on `/skills/` and `/.uploads/`). You can now copy a chat as Markdown or export it to a `.md` file from the chat header. The cowork bar — the floating Plan/Files/Context strip — is now side-panel-only since the home view has the same info in its right rail.

**Cancel with double-tap Esc.** Press Esc twice (within half a second) to stop the agent mid-task. A small "Press Esc again to interrupt" hint appears above the composer the first time so you know it's armed. Replaces the old Cmd+Shift+Backspace shortcut, which was hard to discover and didn't work everywhere.
