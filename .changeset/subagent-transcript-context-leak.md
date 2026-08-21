---
"openbrowse": patch
---

Stop a subagent's transcript from leaking into the parent agent's context, and fix subagent token/cost accounting.

`delegate` returned the subagent's full `transcript` — every assistant message with the complete input and output of every tool it called (DOM snapshots, page text, base64 screenshots) — as part of its tool output. The AI SDK puts a tool's return value straight into the model's prompt unless the tool declares a `toModelOutput`, and only `screenshot` had one, so a single `explore`/`general` delegation (up to 100 steps) could push hundreds of thousands of tokens into the parent's context and keep re-sending them for the rest of the turn. No compaction pass could recover it: pruning runs once per turn at send time, never inside the SDK's tool loop, and the screenshot pruners key on the top-level `part.toolName`, so images nested in another tool's output are invisible to them — the same hazard that keeps `screenshot` out of the batchable registry. `toSDKTool` now projects UI-only fields out of the model-facing view; the persisted part keeps the full output, so the inline trace renders unchanged.

Subagent tokens were also recorded nowhere — both the standard and CUA loops only counted steps — so a delegation's spend landed in no conversation's `costUsd` and child Context cards stayed empty. Both loops now attribute usage to the child conversation (CUA against the model that actually ran, which is often not the parent's), and a conversation's cost is its own row plus its children, summed at read time so repeated heal-path finalizes can't double-count.

Finally, the context indicator showed `inputTokens + outputTokens` against an input-only ceiling — the reason it had to clamp at 100%. Display now uses input tokens ("Context Used"), and the compaction trigger keeps the input+output projection under an explicit name, since that's the right number for deciding whether the *next* request fits.
