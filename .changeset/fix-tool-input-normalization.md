---
"openbrowse": patch
---

Make the Anthropic `tool_use.input: Input should be a valid dictionary` error structurally impossible.

The bug: Opus (and any provider) sometimes emits a non-object `input` for a tool call — most commonly `input: ""` for a no-arg MCP tool like Attio's `list-attribute-definitions`. The Anthropic API rejects it with HTTP 400; Gemini coerces it silently, which is why the same conversation 400'd on Opus but worked when retried on Gemini. Once the bad shape was persisted to chat-db, every subsequent send failed until the row was manually purged.

This change closes the failure path at five layers — any one of which would have prevented the bug, and all five together make it impossible to recur from any direction:

1. **`tool-input-normalize.ts`** — new module with a recovery ladder applied at every outbound and persisted boundary. Recovers a stringified-JSON object input (Opus quirk), falls back to `rawInput`, and rescues no-arg MCP tools by coercing `""` / `null` / `42` / `[]` to `{}` when the tool's schema accepts an empty object. Irrecoverable values (e.g. `""` for a tool with required fields) are dropped rather than producing a malformed `tool_use` on the wire.
2. **`mcp/schema-to-zod.ts`** — tightened so every MCP tool's resolved Zod schema is a top-level `z.object({...})`. A non-object input now fails `validateUIMessages` structurally instead of slipping through the previous `z.any()` / `z.record(...)` fallthroughs. Property-level `passthrough()` keeps MCP-server schema drift forward-compatible. Adds support for `additionalProperties`, n-ary `oneOf` / `anyOf`, `allOf`, `format` (uuid / email / url / date-time), `const`, multi-type `type`, and tuple-form `items`.
3. **Persistence sanitization** — `serializeParts` and `deserializeToolPart` route every tool part's `input` through the normalizer, so a non-object value never reaches chat-db (or, for legacy rows, never reaches the live UIMessage list).
4. **chat-db v16 migration** — sweeps every persisted message's parts on first open and either recovers (stringified-JSON / rawInput → object) or excises any tool part with a malformed input. Fixes already-broken conversations without user action.
5. **Last-mile assertion** — `assertModelMessageToolInputs` runs immediately before `agent.stream(...)` (both fast-path and rejection-loop). If a non-object `tool_use.input` somehow slips through layers 1–4, it's coerced to `{}` in place and a `console.error` logs the model-message index, content-block index, tool name, and offending value — converting "the agent mysteriously 400'd on Opus once last week" into a one-look DevTools entry.

Bench harness (`packages/bench/src/agent/headless-chat.ts`) gets the same normalization on its `tool-call` chunk path so future regressions surface in `pnpm bench`.

109 new tests, 6 in a dedicated end-to-end regression suite (`opus-input-bug-regression.test.ts`) that exercises the full pipeline with real-world Attio-style MCP tool schemas. All 1496 tests pass; type checking clean.
