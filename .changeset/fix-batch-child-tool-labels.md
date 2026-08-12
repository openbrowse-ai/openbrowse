---
"openbrowse": patch
---

**Batched tool calls now read like direct ones.** Expanding a `batch` row showed each invocation as its raw tool name plus a generic `key: value` argument dump — `webSearch  query: Kindle API read book content third party app…` — while the same call made on its own read `Searched “Kindle API read book content…” — 8 results`. Four batched searches gave no indication of whether any of them returned anything.

The cause was that label resolution wasn't reusable: it lived as an inline ternary chain inside the `ToolCallBlock` component body, so `tool-results/batch.tsx` had no way to ask what a tool's row would say and fell back to summarizing arguments. It's now an exported `resolveToolLabels(toolName, args, result)`, injected into `BatchResult` the same way `renderChild` already is — the label table lives in `ToolCallBlock`, and importing it from `tool-results/batch` would form a cycle.

- Child rows use the tool's own label, so a batched `webSearch` carries its query **and result count**, a batched `Grep` reads "Searched" rather than `Grep`, and a failed search reads "Search failed: …" instead of looking indistinguishable from a successful one.
- Rows for a batch whose input is still streaming use the same labels in their `pending` form.
- Tools with no specific label keep the existing argument summary rather than degrading to the bare tool name: `resolveToolLabels` returns `undefined` in that case and each caller picks its own fallback.
- No behaviour change for top-level rows. The denied paths still read `deniedReplace`/`denied` from the tool's static entry, which the per-tool helpers don't customize.

+9 tests on the extracted resolver, covering the reported `webSearch` case, static-only tools, result-derived labels, the `undefined` signal, and malformed arguments.
