---
"openbrowse": patch
---

Fewer false "let me try again" moments at the end of a task.

OpenBrowse runs a quick "did the agent actually finish?" check before handing the answer to you. That check used to second-guess the agent on things it had no good way to verify — like whether the agent's claim was backed up by the (heavily truncated) tool-call log. When the agent saw something on the live page that the log later cut off, the check would treat the missing evidence as fabrication and bounce the agent back to keep working. The result: completed tasks getting unnecessarily redone.

The check now focuses on what it can actually judge: did the agent address what you asked for, did it close out its own plan, and did it stop short instead of finishing? The fabrication- and page-state-checking dimensions are gone. The check still defaults to skeptical and still defers to what the agent saw — it just stops rejecting answers based on absent evidence.
