---
"openbrowse": minor
---

**Chat from any new tab.** Cmd-T (or any new tab) now opens straight into a chat surface — same composer, sidebar, and conversation list as the pinned home tab, sharing all your chats and spaces. Cmd-N still opens to a single pinned home tab as before. The pinned home tab keeps its existing role as the durable space anchor and scheduled-run host; new tabs are an additional, ephemeral on-ramp into the same UI. Each new-tab chat shows the conversation title in Chrome's tab strip so you can tell several open NTPs apart at a glance, and the chat input grabs focus the first time you click the page or hit Tab/Escape on the omnibox.

**Fix:** the `⋮` menu on Space cards and on the active-space row in the sidebar now opens correctly. The trigger button was silently dropping the click that toggles the menu, so the Delete action was unreachable.
