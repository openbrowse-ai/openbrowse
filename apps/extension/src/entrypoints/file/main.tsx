// apps/extension/src/entrypoints/file/main.tsx
import { FileViewerPanel } from "@/components/files/FileViewerPanel";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/hooks/useTheme";
import React from "react";
import ReactDOM from "react-dom/client";
// Reuse the artifact tab's stylesheet — it's a generic theme + shiki + code
// styling bundle with nothing artifact-specific, so it applies cleanly to the
// standalone file viewer too.
import "../artifact/app.css";

// The opener (FileViewerPanel's "Open in new tab") passes the OPFS path and a
// display name. OPFS is scoped to the extension origin and shared across every
// extension page, so this tab can read the exact same file by path.
const params = new URLSearchParams(window.location.search);
const filePath = params.get("path") ?? "";
const fileName =
  params.get("name") ?? filePath.split("/").pop() ?? filePath ?? "File";

if (fileName) document.title = `${fileName} — OpenBrowse`;

function ThemedApp() {
  useTheme();

  return (
    <TooltipProvider delayDuration={300}>
      {filePath ? (
        // No `openInNewTab` here: this *is* the standalone tab, so re-offering
        // it would just spawn a duplicate of itself. Close returns to the tab
        // the user came from by closing this one.
        <FileViewerPanel
          filePath={filePath}
          fileName={fileName}
          onClose={() => window.close()}
          className="h-screen"
        />
      ) : (
        <div className="flex h-screen items-center justify-center p-6 text-sm text-muted-foreground">
          No file path was provided.
        </div>
      )}
      <Toaster />
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>,
);
