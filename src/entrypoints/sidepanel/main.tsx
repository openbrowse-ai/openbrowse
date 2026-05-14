import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import "./app.css";

const sidepanelPort = chrome.runtime.connect({ name: "sidepanel" });
chrome.windows.getCurrent().then((w) => {
  if (w.id != null) {
    try {
      sidepanelPort.postMessage({ type: "SIDEPANEL_HELLO", windowId: w.id });
    } catch {}
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={200}>
      <App />
      <Toaster position="bottom-center" />
    </TooltipProvider>
  </React.StrictMode>,
);
