---
"openbrowse": minor
---

Agent can now clean up the tabs it opened: a `closeTabs` tool closes the conversation's tab group (or specific tabs you opened) with a reversible Undo toast, plus manual control over the workspace Context card. Adds a bundled `writing-skills` skill that guides the agent through authoring a new skill and installing it via `create_skill`. Also fixes `closeTabs` being rejected by the Anthropic API (its tool input schema now serializes to a top-level object), which previously broke agent turns on Anthropic models.
