import { useState, useEffect } from "react";
import type { Settings } from "@/lib/types";
import { providers } from "@/registry/providers";
import { ProviderSection, type ModelState } from "./ProviderSection";

interface ModelsTabProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

export function ModelsTab({ settings, onChange }: ModelsTabProps) {
  const [modelStates, setModelStates] = useState<Record<string, ModelState>>({});

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
      <div>
        <h2 className="text-sm font-medium">AI Providers & Models</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Configure providers and enable models for use across the extension.
        </p>
      </div>

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
