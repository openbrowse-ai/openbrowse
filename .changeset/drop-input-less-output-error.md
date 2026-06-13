---
"openbrowse": patch
---

Fix Anthropic/Opus `tool_use.input: Field required` from failed tool calls.

A terminal failed tool call (e.g. a failed MCP "Updated list entry") whose
input was never captured was replayed on the next turn as a `tool_use` block
with no `input`. Anthropic rejected the request with `tool_use.input: Field
required` (a visible "Something went wrong"); Gemini coerced it, so the bug
only reproduced on Opus. The send-time heal now drops these input-less errored
and denied calls before they reach the provider, while keeping any call that
has a real input or a partial `rawInput` (which the SDK fills in).
