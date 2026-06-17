---
"openbrowse": patch
---

Data plumbing: `saveAs` on `executeOnPage`/`executeCode`, atomic workspace writes, removed `executePython`'s `input` parameter.

Three execution sandboxes in the extension (`executeOnPage`, `executeCode`, `executePython`) share no filesystem — they're each in different origins, and only `executePython` has access to `/workspace` (the conversation's OPFS). The agent had no first-class way to move bytes between them, so it would route data through chat context: a tool returns a string, the agent sees it, the agent calls another tool with the string as an argument. For payloads larger than a few KB this bloats context, triggers truncation, and pushes the agent into ad-hoc transports (chunk-and-stitch, base64, browser downloads, CORS proxies). One real chat hit 30+ tool calls trying to move a 62 KB JSON between `executeOnPage` and `executePython`.

This change adds a `saveAs: "<path>"` parameter to both `executeOnPage` and `executeCode`. When set, the script's return value is written directly to `/workspace/<path>` by the host, and the tool result is `{ path, bytes, sha256 }` (plus `tab` or `logs`) instead of the data — so the bytes never enter chat context. Strings are written as text; binary content uses the envelope `{ __binary_b64: "..." }`. Writes go through new `OPFS.writeFileAtomic` / `writeFileBytesAtomic` helpers that stage to a `<path>.tmp-<rand>` sibling, so a producer crash mid-serialize never truncates a previously-good file.

Companion: removed `executePython`'s `input` parameter. Its description ("JSON-encoded data made available as the Python global `__input`") read like the canonical channel for passing data into Python, but the parameter only worked for small JSON-shaped payloads and silently failed on `JsProxy` values, which sent agents into spirals when they mistook it for the right transport. With `saveAs` and the existing `Write` + `/workspace` path, `input` was redundant. Skills that referenced it (`python-env`, `csv-to-markdown` in `writing-skills`) have been updated to the file-based pattern.

New `data-plumbing` skill documents the canonical recipes (page → /workspace → Python), the three-sandbox model, anti-patterns from past failures, and recovery moves. Loaded by trigger phrases like "scrape this page", "build a CSV", "save the JSON".

Sandbox 1 MB JSON-output cap is bypassed when `saveAs` is set — the cap exists to protect chat context, but `saveAs` already does that more directly.
