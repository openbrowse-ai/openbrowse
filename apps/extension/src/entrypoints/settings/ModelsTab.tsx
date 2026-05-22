import { useState, useEffect } from "react";
import type { Settings } from "@/lib/types";
import { useProviders } from "@/hooks/useProviders";
import { refreshCatalog } from "@/registry/models-dev/catalog";
import { ProviderSection, type ModelState } from "./ProviderSection";

interface ModelsTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export function ModelsTab({ settings, onChange }: ModelsTabProps) {
  const { providers, lastUpdated } = useProviders({
    includePreview: Boolean(settings.includePreviewModels),
  });
  const [modelStates, setModelStates] = useState<Record<string, ModelState>>({});
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefreshCatalog() {
    setRefreshing(true);
    try {
      await refreshCatalog({ force: true });
    } finally {
      setRefreshing(false);
    }
  }

  // Listen for download progress messages from background
  useEffect(() => {
    function handleMessage(message: unknown) {
      // #region DEBUG
      console.log("[DEBUG H4] settings received message:", message);
      // #endregion DEBUG
      const msg = message as { type?: string; modelKey?: string; progress?: number; done?: boolean; error?: string };
      if (msg.type === "DOWNLOAD_PROGRESS" && msg.modelKey) {
        // #region DEBUG
        console.log("[DEBUG H4] DOWNLOAD_PROGRESS matched, key:", msg.modelKey, "progress:", msg.progress);
        // #endregion DEBUG
        setModelStates((prev) => ({
          ...prev,
          [msg.modelKey!]: {
            modelKey: msg.modelKey!,
            downloading: !msg.done && !msg.error,
            progress: msg.progress ?? 0,
            error: msg.error,
          },
        }));
      }
    }

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, []);

  function handleDownload(providerId: string, modelId: string) {
    const key = `${providerId}:${modelId}`;
    // #region DEBUG
    console.log("[DEBUG H5] handleDownload called, providerId:", providerId, "modelId:", modelId, "key:", key);
    // #endregion DEBUG
    setModelStates((prev) => ({
      ...prev,
      [key]: { modelKey: key, downloading: true, progress: 0 },
    }));
    if (providerId === "browser-ai") {
      // #region DEBUG
      console.log("[DEBUG H5] sending DOWNLOAD_BROWSER_AI to background");
      // #endregion DEBUG
      chrome.runtime.sendMessage({ type: "DOWNLOAD_BROWSER_AI" });
    } else {
      chrome.runtime.sendMessage({ type: "DOWNLOAD_MODEL", modelId });
    }
  }

  function handleDelete(providerId: string, modelId: string) {
    const key = `${providerId}:${modelId}`;
    chrome.runtime.sendMessage({ type: "DELETE_MODEL", modelId });
    // Optimistically remove from downloaded and enabled
    onChange({
      downloadedModels: settings.downloadedModels.filter((m) => m !== modelId),
      enabledModels: settings.enabledModels.filter((m) => m !== key),
    });
    setModelStates((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">AI Providers & Models</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure providers and enable models for use across the extension.
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Catalog: {lastUpdated
              ? `last updated ${new Date(lastUpdated).toLocaleString()}`
              : "bundled snapshot"}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefreshCatalog}
          disabled={refreshing}
          className="shrink-0 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh catalog"}
        </button>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={Boolean(settings.includePreviewModels)}
          onChange={(e) =>
            onChange({ includePreviewModels: e.target.checked })
          }
        />
        Include preview / alpha models
      </label>

      {providers.map((provider) => (
        <ProviderSection
          key={provider.id}
          provider={provider}
          settings={settings}
          onChange={onChange}
          modelStates={modelStates}
          onDownload={handleDownload}
          onDelete={handleDelete}
        />
      ))}
    </div>
  );
}
