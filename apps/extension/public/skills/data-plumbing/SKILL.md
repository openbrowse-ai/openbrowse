---
name: data-plumbing
description: Move data between sandboxes (page → /workspace → Python) without bloating chat context. Load this whenever you're scraping, fetching, or extracting data on a page and need to process it later in Python — or any time a tool's return value is larger than a few KB. Triggers include "scrape this page", "extract all the X from", "build a CSV from", "save the JSON", "fetch the data and analyze it", "download the table", and similar. Covers `saveAs` on `executeOnPage` / `executeCode`, atomic writes, when to use `pyfetch` vs `executeOnPage`, and the canonical recipes that avoid the 30-tool-call data-roundtrip spiral.
---

# `data-plumbing` Skill: Moving Bytes Between Sandboxes

OpenBrowse has three execution sandboxes. **None of them share a filesystem with another.** This is the single most important fact about getting data from one place to another. Internalize this table before doing any scraping or data-extraction task.

## The three sandboxes

| Tool | Origin | `/workspace` access | DOM / cookies | Network |
|---|---|---|---|---|
| `executeOnPage` | the active tab's site origin | **No** | Yes (full DOM, page globals, site cookies) | Yes, as the site (no CORS for same-origin XHR) |
| `executeCode` (JS) | sandboxed iframe in the extension | **No** | No DOM | Yes, but bound by CORS |
| `executePython` | offscreen iframe in the extension | **Yes** (`/workspace` and `/skills`) | No DOM | Off by default; opt in with `allow_network: true` |

Only `executePython` can read and write `/workspace`. Anything else has to *hand off* its data through a tool result — and tool results travel through the chat context, which has practical size limits and is wasted on payloads.

## The two transports you should know

### Transport 1: `saveAs` (preferred for any payload >~4 KB)

Both `executeOnPage` and `executeCode` accept an optional `saveAs: "<path>"` parameter. When set, the script's return value is written **directly** to `/workspace/<path>` by the host, and the tool result includes `path`, `bytes`, and `sha256` instead of the data — the bytes themselves are **not** echoed back to the chat. (`executeOnPage` also includes its `tab` handle; `executeCode` also includes its `logs`.)

The script must return either:

- a **string** (written as text), or
- `{ __binary_b64: "<base64-encoded bytes>" }` (decoded and written as bytes).

Anything else is rejected — the tool will surface an error rather than silently coerce.

Writes are **atomic**: the destination file is either fully written or unchanged. A producer crash mid-stringify will not truncate a previously-good file.

**Canonical recipe — page → /workspace → Python:**

```text
1. executeOnPage({
     tab: "t1",
     code: "return JSON.stringify(await (await fetch('/api/data')).json());",
     saveAs: "data.json"
   })
   → { tab: "t1", path: "data.json", bytes: 62169, sha256: "abc123..." }

2. executePython({
     code: "import json; data = json.load(open('/workspace/data.json')); …"
   })
```

That's the whole shape. Do not paginate-then-stringify-then-chunk-then-base64. Do not return the data via the tool result and then call `Write` to save it. Use `saveAs`.

### Transport 2: `Write` + `Read` (for small payloads or when you already have the bytes in chat)

If a tool already returned data into the chat (e.g., a small `executeOnPage` result without `saveAs`), you can persist it with:

```text
Write({ file_path: "data.json", content: "<the data>" })
executePython({ code: "..." })
```

This works but it's strictly worse than `saveAs` for anything large: the data has to round-trip through the chat context first. Reserve `Write` for content the agent itself authored (notes, generated reports, edited files).

## When to use which scraper

| You need... | Use |
|---|---|
| To scrape a logged-in page using its session cookies | `executeOnPage` (runs in the site origin with cookies attached) |
| To call a public JSON API | `executeOnPage` (same-origin from the page is CORS-free; cross-origin works if the API has CORS headers) |
| To do anonymous cross-origin HTTP from the extension | `executeCode` if the API has CORS headers; otherwise `executeOnPage` |
| To fetch from inside Python | Usually the wrong tool. `pyfetch` runs in a `null`-origin iframe, so any cross-origin endpoint without permissive CORS will fail (`AbortError: Failed to fetch`). It works for endpoints that do allow it, but you have no obvious way to know in advance. Prefer `executeOnPage` or `executeCode` with `saveAs`, then read the file from Python — that path is reliable regardless of CORS. |

## Anti-patterns from past failures

These have all happened. Don't repeat them.

- **Returning a 60 KB string from `executeOnPage` and then trying to stuff it through `executePython`'s removed `input` parameter.** The `input` parameter is gone. Use `saveAs` and read the file in Python.
- **Slicing a return value into 30 KB chunks and reassembling them.** This burns context and is fragile. `saveAs` exists.
- **`pyfetch` to a third-party API that has CORS-restrictive headers.** Will fail with `AbortError: Failed to fetch`. Switch to `executeOnPage` if you have a tab on a related origin, or `executeCode` if the API permits cross-origin.
- **Truncate-on-failure writes.** `open(path, 'w')` truncates immediately; if your producer throws after the open, the destination is empty. Inside Python, write to a `.tmp` sibling and `os.replace` on success. (`saveAs` already does this for you in the page/JS case.)
- **Re-fetching after a tab handle was invalidated by navigation.** Tab handles can change. If a snapshot or executeOnPage call returns "Unknown tab handle", call `listTabs` to get fresh handles instead of inventing a new transport.

## Recovery moves when something fails

When a `saveAs` call errors, the destination file is unchanged. The error message tells you exactly which validation rejected it (path traversal, bad return type, no conversation, etc.).

When a `saveAs` write succeeds but Python downstream complains about "missing data":

1. `LS({ path: "." })` — confirm the file exists at the expected path.
2. Compare the `bytes` from the tool result against `os.path.getsize` in Python — they should match.
3. Compare the `sha256` from the tool result against `hashlib.sha256(open(path,'rb').read()).hexdigest()` if you suspect corruption.

Almost always the file is fine and the Python script has a path bug.

## Putting it together: the Luma guest list (cautionary tale)

Goal: scrape 387 guests from a site, build a CSV grouping them by company.

**Wrong** (what someone once did, ~30 tool calls):

```text
executeOnPage → JS scrolls a virtual list, returns scraped JSON in chunks
[chat context bloats; agent invents a chunk-and-base64 transport]
executePython → tries to use `input` param, JsProxy crash, file truncated
[CORS proxies tried, browser downloads triggered, multiple retries]
```

**Right** (~3 tool calls):

```text
executeOnPage({
  tab,
  code: "
    // Find the API the page already uses, paginate it.
    const all = []; let cursor = null;
    while (true) {
      const r = await fetch(`/api/event/get-guest-list?...&pagination_cursor=${cursor || ''}`);
      const j = await r.json();
      all.push(...j.entries);
      if (!j.has_more) break;
      cursor = j.next_cursor;
    }
    return JSON.stringify(all);
  ",
  saveAs: "guests.json"
})

executePython({
  code: "
    import json, csv
    guests = json.load(open('/workspace/guests.json'))
    with open('/workspace/guests.csv','w',newline='') as f:
      w = csv.writer(f)
      w.writerow(['name','company','linkedin','twitter'])
      for g in guests:
        u = g['user']
        w.writerow([u['name'], parse_company(u.get('bio_short')), u.get('linkedin_handle',''), u.get('twitter_handle','')])
  "
})
```

The right shape is two big tool calls, not thirty small ones. Whenever you find yourself splicing strings to move data, stop and use `saveAs`.
