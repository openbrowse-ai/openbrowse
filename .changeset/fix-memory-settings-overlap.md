---
"openbrowse": patch
---

**Fix overlapping Memory cards in Settings.**

The Memory tab's User Memories and Space Memories sections were rendering on top of each other — the space section's heading visually overlapped the last User Memories card, and the empty-state text appeared in the wrong place. Cause: each list was wrapped in a Radix `ScrollArea` with `max-h-[300px]` but no fixed height, so `ScrollArea.Root` collapsed to 0px while its absolutely-positioned content painted out of flow. Removed the inner scroll regions; the settings panel already has its own outer scroll container, so the two `<section>`s now flow normally with correct spacing.
