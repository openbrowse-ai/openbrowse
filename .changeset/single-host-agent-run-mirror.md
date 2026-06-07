---
"openbrowse": patch
---

Prevent multiple open tabs from auto-restarting the same agent run, and
mirror live agent progress across tabs.

- Disable message-load auto-resume (it made every open context restart
  the same run).
- Add an atomic per-conversation ownership lock so only one context
  drives a run.
- Stream full-message snapshots to other tabs as read-only viewers;
  approvals and stop are forwarded to the owner.
