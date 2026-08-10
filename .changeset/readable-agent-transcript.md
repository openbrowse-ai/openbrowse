---
"openbrowse": patch
---

Make a long agent run readable: separate the agent's progress notes from its final answer, and present a delegated subagent as a layer below the conversation.

- **Progress notes vs. final answer.** Every text part used to be a hard break in the transcript (`buildSegments`), which had two effects: the agent's between-call commentary ("Let me check the pricing page.") was preserved forever as body prose at the same visual weight as the actual answer, and it chopped runs of tool calls too finely to ever reach the "Completed N steps" fold threshold. The result alternated preamble, fold, preamble, fold. `findNarrationIndices` now classifies each text part as narration or answer; narration renders small and muted in place, above the calls it introduced, and folds away with them into the step group.
- **Guards so a real answer is never folded.** Text over 400 characters stays at full weight even when tool calls follow it, and once the stream ends the last non-empty text part is always the answer — so a terse "Done — updated 3 rows." followed by `closeTabs` cleanup stays visible.
- **Lower fold threshold.** Because narration no longer splits runs, a group folds at 2 tool calls instead of 3.
- **Prompt guidance.** A new `## Narrating your work` section tells the model about the two channels: one short progress note per batch of calls, no restating tool results or re-explaining the plan, and never leave the answer in a progress note alone, since those get folded away.
- **Subagent runs read as a nested layer.** A `delegate` trace block — header and body together — now sits behind a `ㄴ` branch marker, so a delegation looks like one indented step in the parent transcript rather than a continuation of the parent's own work. The marker is decorative and unselectable, so copying a transcript doesn't pick it up.
- **Subagent traces start collapsed.** The block opened expanded, so a subagent that ran 30 tool calls dumped all 30 into the parent conversation — burying the work the user delegated away precisely so they wouldn't have to read it. The header row already carries the live status (shimmering title while running, step count, failure dot), so the run stays legible at a glance and expands on click.
