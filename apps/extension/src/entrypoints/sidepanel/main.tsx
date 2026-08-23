import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import { ensurePersistedStorage } from "@/lib/storage-persistence";
import "./app.css";

// See newtab/main.tsx: persist() is Window-only, so every document
// surface opts in. Idempotent per document, and a no-op once granted.
void ensurePersistedStorage();

// `sidepanel.html` is loaded both in Chrome's side panel and inside the
// detached popup window. The "sidepanel" port + SIDEPANEL_HELLO is the
// signal the background uses to populate `sidePanelOpenByWindow` for
// toast / focus emission. The popup is not a real side panel, so skip
// the port handshake when running in popup mode to avoid polluting
// that map with the popup's window id.
const isPopupMode = new URLSearchParams(window.location.search).get("mode") === "popup";

if (!isPopupMode) {
  const sidepanelPort = chrome.runtime.connect({ name: "sidepanel" });
  chrome.windows.getCurrent().then((w) => {
    if (w.id != null) {
      try {
        sidepanelPort.postMessage({ type: "SIDEPANEL_HELLO", windowId: w.id });
      } catch {}
    }
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={200}>
      <App />
      <Toaster position="bottom-center" />
    </TooltipProvider>
  </React.StrictMode>,
);
