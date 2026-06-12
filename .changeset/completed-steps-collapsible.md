---
"openbrowse": patch
---

Fold completed tool calls into a "Completed N steps" collapsible.

While tools are running they stay expanded and live; once the assistant
begins its answer text, a run of 3+ tool calls auto-folds into a
collapsible labeled "Completed N steps" (click to re-expand), matching
the Perplexity Comet pattern. Runs of 1-2 tools, reasoning-only groups,
and pending approval prompts render inline as before.
