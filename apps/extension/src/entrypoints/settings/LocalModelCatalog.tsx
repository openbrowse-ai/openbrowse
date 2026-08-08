import type { Settings } from "@/lib/types";
import type { ProviderDefinition } from "@/registry/providers/types";
import { WEB_LLM_MODEL_CONTEXT } from "@/registry/providers/web-llm-model-context";
import { InlineHelp } from "@/components/ui/inline-help";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type BaseModel,
  formatContextWindow,
  groupLocalModels,
  isBaseDownloaded,
} from "./local-model-catalog";
import { ModelRow, type ModelState } from "./ProviderSection";

interface LocalModelCatalogProps {
  provider: ProviderDefinition;
  settings: Settings;
  modelStates: Record<string, ModelState>;
  downloadBusy?: boolean;
  onDownload: (providerId: string, modelId: string) => void;
  onDelete: (providerId: string, modelId: string) => void;
  query?: string;
}

function isLowResource(modelId: string): boolean {
  return WEB_LLM_MODEL_CONTEXT[modelId]?.lowResource ?? false;
}

/**
 * Browsable catalog for a local provider with many models (WebLLM). Instead of
 * a flat list of ~139 quantization variants it shows:
 *   - an "Installed" section (downloaded models, always visible), and
 *   - a "Catalog" grouped by family (collapsed by default), where each base
 *     model collapses its quant variants behind a single expandable row.
 * A search query auto-expands everything so matches are never hidden.
 */
export function LocalModelCatalog({
  provider,
  settings,
  modelStates,
  downloadBusy = false,
  onDownload,
  onDelete,
  query,
}: LocalModelCatalogProps) {
  const q = (query || "").trim().toLowerCase();
  const downloaded = settings.downloadedModels;

  const filtered = useMemo(() => {
    if (!q) return provider.models;
    return provider.models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [provider.models, q]);

  const families = useMemo(() => groupLocalModels(filtered), [filtered]);

  const installed = useMemo(
    () =>
      families
        .flatMap((f) => f.bases)
        .filter((b) => isBaseDownloaded(b, downloaded))
        .sort((a, b) => a.baseName.localeCompare(b.baseName)),
    [families, downloaded],
  );

  const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
  const toggleFamily = (family: string) =>
    setOpenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });

  const rowFor = (modelId: string, displayName: string, isDownloaded: boolean) => {
    const model = filtered.find((m) => m.id === modelId);
    if (!model) return null;
    return (
      <ModelRow
        key={modelId}
        model={model}
        provider={provider}
        displayName={displayName}
        downloaded={isDownloaded}
        state={modelStates[`${provider.id}:${modelId}`]}
        downloadBusy={downloadBusy}
        onDownload={() => onDownload(provider.id, modelId)}
        onDelete={() => onDelete(provider.id, modelId)}
      />
    );
  };

  return (
    <div className="mt-5 flex flex-col gap-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Local models run entirely in your browser, so quality varies by
        device. Some may produce{" "}
        <InlineHelp term="garbled output">
          These models run through WebGPU, and certain quantizations don't
          work correctly on every GPU or driver. The model still loads, but
          generates random tokens instead of coherent text. This is a known
          WebLLM limitation, not a problem with your setup.
        </InlineHelp>{" "}
        on some hardware. If that happens, try a different quantization (a
        q4f32 build often works when q4f16 fails) or another model.
      </p>
      {installed.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Installed
          </p>
          {installed.flatMap((base) =>
            base.variants
              .filter((v) => downloaded.includes(v.model.id))
              .map((v) =>
                rowFor(
                  v.model.id,
                  base.variants.length > 1
                    ? `${base.baseName} · ${v.quant}`
                    : base.baseName,
                  true,
                ),
              ),
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Catalog
        </p>
        {families.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            No models match your search.
          </p>
        )}
        {families.map((family) => {
          const open = q !== "" || openFamilies.has(family.family);
          const installedCount = family.bases.filter((b) =>
            isBaseDownloaded(b, downloaded),
          ).length;
          return (
            <div key={family.family} className="flex flex-col">
              <button
                type="button"
                onClick={() => toggleFamily(family.family)}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-muted/50"
              >
                <ChevronRight
                  className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                    open ? "rotate-90" : ""
                  }`}
                />
                <span className="text-sm font-medium">{family.family}</span>
                <span className="text-[10px] text-muted-foreground">
                  {family.bases.length} model
                  {family.bases.length === 1 ? "" : "s"}
                  {installedCount > 0 ? ` · ${installedCount} installed` : ""}
                </span>
              </button>
              {open && (
                <div className="ml-4 flex flex-col gap-1 border-l pl-2">
                  {family.bases.map((base) => (
                    <CatalogBaseRow
                      key={base.baseKey}
                      base={base}
                      providerId={provider.id}
                      downloaded={downloaded}
                      rowFor={rowFor}
                      forceOpen={q !== ""}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CapabilityBadges({
  capabilities,
  lowResource,
}: {
  capabilities: BaseModel["capabilities"];
  lowResource: boolean;
}) {
  const badges = [...capabilities.filter((c) => c !== "chat")];
  return (
    <span className="flex gap-1">
      {badges.map((cap) => (
        <span
          key={cap}
          className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {cap}
        </span>
      ))}
      {lowResource && (
        <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          light
        </span>
      )}
    </span>
  );
}

function CatalogBaseRow({
  base,
  providerId,
  downloaded,
  rowFor,
  forceOpen,
}: {
  base: BaseModel;
  providerId: string;
  downloaded: string[];
  rowFor: (
    modelId: string,
    displayName: string,
    isDownloaded: boolean,
  ) => React.ReactNode;
  forceOpen: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Single-variant base: render the row directly, no nesting.
  if (base.variants.length === 1) {
    const v = base.variants[0];
    return <>{rowFor(v.model.id, base.baseName, downloaded.includes(v.model.id))}</>;
  }

  const expanded = open || forceOpen;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          />
          <span className="truncate text-sm">{base.baseName}</span>
          <CapabilityBadges
            capabilities={base.capabilities}
            lowResource={isLowResource(base.variants[0].model.id)}
          />
          {base.variants[0].model.contextWindow ? (
            <span className="text-[10px] text-muted-foreground">
              {formatContextWindow(base.variants[0].model.contextWindow)} ctx
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {base.variants.length} versions
        </span>
      </button>
      {expanded && (
        <div className="ml-5 flex flex-col gap-1">
          {base.variants.map((v) =>
            rowFor(v.model.id, v.quant || v.model.name, downloaded.includes(v.model.id)),
          )}
        </div>
      )}
    </div>
  );
}
