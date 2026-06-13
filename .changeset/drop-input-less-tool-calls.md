---
"openbrowse": patch
---

Fix interrupted tool calls breaking the next request.

A tool call aborted before its arguments finished streaming was replayed
on the next turn as a `tool_use` block with no `input`, which providers
reject — Anthropic/Bedrock with `tool_use.input: Field required` (a
visible "Something went wrong" error) and Gemini/Vertex with a silent
malformed-function-call error that just stopped the generation. The
send-time heal now drops these input-less interrupted calls before they
reach the provider, so the conversation can continue.
