---
"openbrowse": patch
---

Prevent multiple tabs from auto-restarting the same agent run and mirror live agent progress across tabs. Disables message-load auto-resume, adds an atomic per-conversation ownership lock so only one context drives a run, and streams full-message snapshots to other open tabs as read-only viewers (with approval/stop forwarded to the owner).
