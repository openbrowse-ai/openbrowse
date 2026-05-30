import { useMemo } from "react";
import { useProviders } from "@/hooks/useProviders";
import type { ProviderModels } from "@/components/chat/ModelPicker";

/**
 * Settings slice the configured-models computation depends on. Kept
 * narrow (rather than the full `Settings`) so callers can pass whatever
 * settings object they already hold without coupling to its full shape.
 */
export interface ConfiguredModelsSettings {
  /** providerId → config values (api keys etc.). */
  providerConfigs: Record<string, Record<string, string>>;
  /** Locally-downloaded model ids (web-llm / browser-ai). */
  downloadedModels: string[];
}

/**
 * The set of selectable models grouped by provider, filtered to
 * providers the user has actually configured.
 *
 * A provider is included when:
 *  - `byok`: every required `configSchema` field is present in
 *    `settings.providerConfigs[provider.id]`.
 *  - `web-llm` / `browser-ai`: at least one of its models is in
 *    `settings.downloadedModels` (and only those models are listed).
 *  - any other setup: included as-is.
 *
 * This is the single source of truth shared by the chat composer's
 * model selector and the settings auxiliary-model pickers (tidy /
 * compaction / completion-check), so the latter no longer show only
 * favorited models.
 *
 * Extracted from the logic previously inlined in `ChatView`.
 */
export function useConfiguredModels(
  settings: ConfiguredModelsSettings,
): ProviderModels[] {
  const { providers } = useProviders();
  return useMemo(() => {
    return providers
      .map((provider) => {
        let enabled = true;
        let availableModels = provider.models;

        if (provider.setup === "byok") {
          const config = settings.providerConfigs[provider.id] ?? {};
          const requiredFields =
            provider.configSchema?.filter((f) => f.required) ?? [];
          enabled = requiredFields.every((f) => !!config[f.key]);
          if (!enabled) return null;
        } else if (provider.setup === "web-llm") {
          availableModels = provider.models.filter((m) =>
            settings.downloadedModels.includes(m.id),
          );
          enabled = availableModels.length > 0;
          if (!enabled) return null;
        } else if (provider.setup === "browser-ai") {
          availableModels = provider.models.filter((m) =>
            settings.downloadedModels.includes(m.id),
          );
          enabled = availableModels.length > 0;
          if (!enabled) return null;
        }

        return {
          provider: provider.id,
          label: provider.name,
          models: availableModels,
          enabled,
        } as ProviderModels;
      })
      .filter((p): p is ProviderModels => p !== null);
  }, [providers, settings.providerConfigs, settings.downloadedModels]);
}
