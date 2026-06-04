---
"openbrowse": patch
---

Fix chat input lag in long conversations. The message list is now memoized and
extracted from the input's render path, so typing no longer re-renders every
message (markdown + syntax highlighting) on each keystroke.
