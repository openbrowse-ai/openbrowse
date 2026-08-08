import { Button } from "@/components/ui/button";
import { RegistryIcon } from "@/components/ui/registry-icon";
import type { Settings } from "@/lib/types";
import type {
  ModelDefinition,
  ProviderDefinition,
} from "@/registry/providers/types";
import { useState } from "react";
import { ProviderConfigDialog } from "./ProviderConfigDialog";
import { LocalModelCatalog } from "./LocalModelCatalog";
import { formatContextWindow } from "./local-model-catalog";

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
  /** True while any model download is in flight (see ModelsTab). */
  downloadBusy?: boolean;
  onDownload: (providerId: string, modelId: string) => void;
  onDelete: (providerId: string, modelId: string) => void;
  query?: string;
}

export function ProviderSection({
  provider,
  settings,
  onChange,
  modelStates,
  downloadBusy = false,
  onDownload,
  onDelete,
  query,
}: ProviderSectionProps) {
  const [configOpen, setConfigOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const providerConfig = settings.providerConfigs[provider.id] ?? {};
  const isConfigured =
    provider.setup !== "byok" || Object.keys(providerConfig).length > 0;

  function isModelDownloaded(modelId: string) {
    return settings.downloadedModels.includes(modelId);
  }

  function handleSaveConfig(config: Record<string, string>) {
    onChange({
      providerConfigs: {
        ...settings.providerConfigs,
        [provider.id]: config,
      },
    });
  }

  const q = (query || "").trim().toLowerCase();
  const providerMatches = q
    ? provider.name.toLowerCase().includes(q) ||
      provider.id.toLowerCase().includes(q)
    : false;

  const filteredModels = provider.models.filter((m) => {
    if (!q) return true;
    if (m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      return true;
    return providerMatches;
  });

  const visibleModels = expanded ? filteredModels : filteredModels.slice(0, 10);
  const hiddenCount = filteredModels.length - visibleModels.length;

  return (
    <div className="rounded-lg border p-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted">
            <RegistryIcon id={provider.id} className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-medium leading-none">
              {provider.name}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {provider.description}
            </p>
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

      {/* WebLLM has ~139 models (mostly quant variants); render the grouped,
          collapsible catalog instead of a flat list. */}
      {provider.setup !== "byok" && provider.id === "web-llm" && (
        <LocalModelCatalog
          provider={provider}
          settings={settings}
          modelStates={modelStates}
          downloadBusy={downloadBusy}
          onDownload={onDownload}
          onDelete={onDelete}
          query={query}
        />
      )}

      {/* Other local providers (few models) keep the simple flat list. */}
      {provider.setup !== "byok" && provider.id !== "web-llm" && (
        <div className="flex flex-col gap-1 mt-5">
          {visibleModels.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              provider={provider}
              downloaded={isModelDownloaded(model.id)}
              state={modelStates[`${provider.id}:${model.id}`]}
              downloadBusy={downloadBusy}
              onDownload={() => onDownload(provider.id, model.id)}
              onDelete={() => onDelete(provider.id, model.id)}
            />
          ))}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="self-start mt-2 text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
            >
              Show {hiddenCount} more models
            </button>
          )}

          {expanded && filteredModels.length > 10 && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="self-start mt-2 text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
            >
              Show fewer
            </button>
          )}
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

export function ModelRow({
  model,
  provider,
  downloaded,
  state,
  downloadBusy = false,
  onDownload,
  onDelete,
  displayName,
}: {
  model: ModelDefinition;
  provider: ProviderDefinition;
  downloaded: boolean;
  state?: ModelState;
  downloadBusy?: boolean;
  onDownload: () => void;
  onDelete: () => void;
  /** Overrides the row label (e.g. base name without the quant tag). */
  displayName?: string;
}) {
  const needsDownload =
    provider.setup === "web-llm" || provider.setup === "browser-ai";
  const isDownloading = state?.downloading ?? false;
  const error = state?.error;
  // Block starting a new download while another one is running; the offscreen
  // engine loads models one at a time.
  const blockedByOther = downloadBusy && !isDownloading;

  return (
    <div className="flex flex-col rounded-md px-2 py-1.5 hover:bg-muted/50">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm truncate">{displayName ?? model.name}</span>
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
          {model.contextWindow ? (
            <span className="text-[10px] text-muted-foreground">
              {formatContextWindow(model.contextWindow)} ctx
            </span>
          ) : null}
          {needsDownload && !downloaded && model.downloadSize && (
            <span className="text-[10px] text-muted-foreground">
              {model.downloadSize}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {needsDownload && !downloaded && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={onDownload}
              disabled={isDownloading || blockedByOther}
            >
              {isDownloading ? `${state?.progress ?? 0}%` : "Download"}
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
        </div>
      </div>

      {error && <p className="text-xs text-destructive mt-1 ml-0.5">{error}</p>}
    </div>
  );
}
