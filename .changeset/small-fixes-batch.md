---
"openbrowse": patch
---

Favorite tabs behave Arc-style: a favorite is recognized by hostname (adopts the first matching open tab, stays recognized while you navigate within the same site, and survives service-worker restarts); reordering favorites in the overlay now moves the real Chrome tabs and keeps them ordered between pinned and regular tabs (with bounce-back on manual reorder). Also: reuse an existing Settings tab instead of opening duplicates; Settings logo no longer navigates; remove Esc-closes-Settings; Models search supports "/" focus and Esc-to-clear with hints; chat-delete dialog keycap styling + optimistic removal; "Send now" on the next queued message; "Continue" action on the chat error banner; overlay footer logo respects dark mode; fix overlay logo/Actions menu close-then-reopen flash; scope the "working on this tab" blocker to the agent's actual tab.
