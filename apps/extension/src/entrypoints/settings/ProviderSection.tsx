import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ProviderDefinition, ModelDefinition } from "@/registry/providers/types";
import type { Settings } from "@/lib/types";
import { ProviderConfigDialog } from "./ProviderConfigDialog";
import { RegistryIcon } from "@/components/ui/registry-icon";

export interface ModelState {
  modelKey: string; // "providerId:modelId"
  downloading?: boolean;
  progress?: number; // 0-100
  error?: string;
}

interface ProviderSectionProps {
  provider: ProviderDefinition;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  modelStates: Record<string, ModelState>;
  onDownload: (providerId: string, modelId: string) => void;
  onDelete: (providerId: string, modelId: string) => void;
}

export function ProviderSection({
  provider,
  settings,
  onChange,
  modelStates,
  onDownload,
  onDelete,
}: ProviderSectionProps) {
  const [configOpen, setConfigOpen] = useState(false);

  const providerConfig = settings.providerConfigs[provider.id] ?? {};
  const isConfigured = provider.setup !== "byok" || Object.keys(providerConfig).length > 0;

  function toggleModel(modelId: string) {
    const key = `${provider.id}:${modelId}`;
    const enabled = settings.enabledModels.includes(key);
    const enabledModels = enabled
      ? settings.enabledModels.filter((m) => m !== key)
      : [...settings.enabledModels, key];
    onChange({ enabledModels });
  }

  function isModelEnabled(modelId: string) {
    return settings.enabledModels.includes(`${provider.id}:${modelId}`);
  }

  function isModelDownloaded(modelId: string) {
    return settings.downloadedModels.includes(modelId);
  }

  function isModelAvailable(model: ModelDefinition) {
    if (provider.setup === "byok") return isConfigured;
    if (provider.setup === "web-llm" || provider.setup === "browser-ai") {
      return isModelDownloaded(model.id);
    }
    return true;
  }

  function handleSaveConfig(config: Record<string, string>) {
    onChange({
      providerConfigs: {
        ...settings.providerConfigs,
        [provider.id]: config,
      },
    });
  }

  return (
    <div className="rounded-lg border p-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
            <RegistryIcon id={provider.id} className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-medium leading-none">{provider.name}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{provider.description}</p>
          </div>
        </div>

        {provider.setup === "byok" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfigOpen(true)}
          >
            {isConfigured ? "Edit" : "Configure"}
          </Button>
        )}
      </div>

      {/* Models list */}
      {(isConfigured || provider.setup !== "byok") && (
        <div className="flex flex-col gap-1 mt-2">
          {provider.models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              provider={provider}
              enabled={isModelEnabled(model.id)}
              available={isModelAvailable(model)}
              downloaded={isModelDownloaded(model.id)}
              state={modelStates[`${provider.id}:${model.id}`]}
              onToggle={() => toggleModel(model.id)}
              onDownload={() => onDownload(provider.id, model.id)}
              onDelete={() => onDelete(provider.id, model.id)}
            />
          ))}
        </div>
      )}

      {/* Config dialog */}
      {provider.configSchema && (
        <ProviderConfigDialog
          provider={provider}
          open={configOpen}
          onOpenChange={setConfigOpen}
          initialConfig={providerConfig}
          onSave={handleSaveConfig}
        />
      )}
    </div>
  );
}

function ModelRow({
  model,
  provider,
  enabled,
  available,
  downloaded,
  state,
  onToggle,
  onDownload,
  onDelete,
}: {
  model: ModelDefinition;
  provider: ProviderDefinition;
  enabled: boolean;
  available: boolean;
  downloaded: boolean;
  state?: ModelState;
  onToggle: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const needsDownload = provider.setup === "web-llm" || provider.setup === "browser-ai";
  const isDownloading = state?.downloading ?? false;
  const error = state?.error;

  return (
    <div className="flex flex-col rounded-md px-2 py-1.5 hover:bg-muted/50">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm truncate">{model.name}</span>
          {model.capabilities.length > 0 && (
            <div className="flex gap-1">
              {model.capabilities.map((cap) => (
                <span
                  key={cap}
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground"
                >
                  {cap}
                </span>
              ))}
            </div>
          )}
          {needsDownload && !downloaded && model.downloadSize && (
            <span className="text-[10px] text-muted-foreground">{model.downloadSize}</span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {needsDownload && !downloaded && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={onDownload}
              disabled={isDownloading}
            >
              {isDownloading
                ? `${state?.progress ?? 0}%`
                : "Download"}
            </Button>
          )}

        {needsDownload && downloaded && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2 text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            Delete
          </Button>
        )}

        {/* Toggle switch (checkbox-based) */}
        {available && (
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={onToggle}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-muted rounded-full peer peer-checked:bg-primary transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4" />
          </label>
        )}
        </div>
      </div>

      {error && (
        <p className="text-xs text-destructive mt-1 ml-0.5">{error}</p>
      )}
    </div>
  );
}
