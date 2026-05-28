---
"openbrowse": patch
---

Fix three small chat issues:

- Completion check no longer runs while a tool call is paused on human approval. The drafted text at that point is mid-narration ("I'll now run X to do Y") and isn't a final response — the gate now waits for the next iteration after approval, when the tool actually has output.
- Long tool error logs collapse to ~10 visual lines with an inline expand toggle. Single-line errors that wrapped to dozens of visual lines now collapse correctly (the previous clamp only counted `\n`-delimited lines). Applied to executeCode/executeOnPage/executePython error output, the skill tool's error block, and the top-level chat error banner.
- "Always allow on <site>" now reliably persists before the agent resumes. The previous implementation fired the storage write and the approval synchronously, so the next tool call's `needsApproval` check could race the write and re-prompt — most reproducible on home.html with back-to-back executeOnPage calls.
