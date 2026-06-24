---
"openbrowse": patch
---

**Sidebar polish + clearer "agent is working" indicator.**

- Clicking the toolbar icon now toggles the side panel, replacing the previous spotlight overlay. Works on every page including `chrome://` URLs where the overlay couldn't inject.
- Removed the redundant logo button from the side panel header — the sidebar already conveys the app context, and `Alt+H` still opens the home view.
- The "Retry from this message" dialog now advertises and accepts `⌘⏎` (or `Ctrl+Enter`) as a confirmation shortcut, matching the rest of the app's keyboard conventions.
- A pulsing blue pixel-art sparkle now marks the active assistant turn from the moment you hit Send through the end of streaming. It replaces the old gray bouncing-dots bubble during the "submitted" phase and stays visible at the end of the streaming text — gating on the local-stream signal so it doesn't disappear in the brief window between agent-start and first token (a regression caused by the cross-tab `isAgentActiveGlobally` flag flipping `isStreaming` on prematurely).
