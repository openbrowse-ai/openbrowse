// apps/extension/src/entrypoints/artifact/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useTheme } from "@/hooks/useTheme";
import { Host } from "./Host";
import "./app.css";

const params = new URLSearchParams(window.location.search);
const id = params.get("id") ?? "";
const modeParam = params.get("mode") === "card" ? "card" : "tab";

// Resolve the app's theme (stored themeMode + system fallback) and mirror it
// onto <html>.dark so the shadcn `.dark` variables apply. The Host reads these
// (and the resolved dark flag) and forwards them into the artifact iframe.
// useTheme already toggles documentElement.classList("dark"); calling it here
// keeps the artifact page in sync with the rest of the app (not just the OS).
function ThemedApp() {
  useTheme();
  return (
    <TooltipProvider delayDuration={300}>
      <Host artifactId={id} mode={modeParam} />
      <Toaster />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>,
);
