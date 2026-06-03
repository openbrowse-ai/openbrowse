---
"openbrowse": patch
---

Tune the completion check to reduce false rejections and latency: the
evaluator now runs as a single fast pass (no tool calls), accepts a
reasonable interpretation of ambiguous requests instead of looping the
agent, and no longer rejects page-grounded facts based on its own stale
knowledge (e.g. "that batch doesn't exist yet").
