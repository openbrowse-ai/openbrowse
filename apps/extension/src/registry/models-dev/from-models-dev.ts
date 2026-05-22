/**
 * Pure mapping function: ModelsDevProvider → ProviderDefinition.
 *
 * Decoupled from network/storage concerns so it's trivially unit-testable.
 * The catalog fetcher (`./catalog.ts`) and the registry composer
 * (`../providers/index.ts`) consume this.
 */

import {
  createLanguageModelFor,
  isSupportedNpm,
} from "./bundled-sdks";
import type { ProviderQuirks } from "./quirks";
import type { ModelsDevModel, ModelsDevProvider } from "./types";
import type {
  ConfigField,
  ModelDefinition,
  ProviderDefinition,
} from "@/registry/providers/types";

export interface MapOptions {
  /** Surface alpha/beta models in the result (deprecated is always hidden). */
  includePreview?: boolean;
}

const DEFAULT_CONFIG_SCHEMA: ConfigField[] = [
  {
    key: "apiKey",
    label: "API Key",
    type: "password",
    required: true,
    placeholder: "sk-...",
  },
];

/**
 * Capabilities derived from a models.dev model:
 * - `chat` always
 * - `tools` from `tool_call`
 * - `vision` from input modalities (image / pdf)
 * - `thinking` from `reasoning`
 */
function capabilitiesOf(model: ModelsDevModel): ModelDefinition["capabilities"] {
  const caps: ModelDefinition["capabilities"] = ["chat"];
  if (model.tool_call) caps.push("tools");
  const inputs = new Set(model.modalities?.input ?? []);
  if (inputs.has("image") || inputs.has("pdf")) caps.push("vision");
  if (model.reasoning) caps.push("thinking");
  return caps;
}

function mapModel(
  model: ModelsDevModel,
  recommendedSet: Set<string>,
): ModelDefinition {
  const def: ModelDefinition = {
    id: model.id,
    name: model.name,
    capabilities: capabilitiesOf(model),
  };
  if (model.family) def.description = model.family;
  if (typeof model.limit?.context === "number") {
    def.contextWindow = model.limit.context;
  }
  if (typeof model.limit?.output === "number") {
    def.maxOutputTokens = model.limit.output;
  }
  if (model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number") {
    def.pricing = {
      inputPer1M: model.cost.input,
      outputPer1M: model.cost.output,
    };
  }
  if (recommendedSet.has(model.id)) def.recommended = true;
  if (model.status) def.status = model.status;
  return def;
}

function shouldIncludeModel(
  model: ModelsDevModel,
  includePreview: boolean,
): boolean {
  if (model.status === "deprecated") return false;
  if (!includePreview && (model.status === "alpha" || model.status === "beta"))
    return false;
  return true;
}

function configSchemaFor(
  provider: ModelsDevProvider,
  quirks: ProviderQuirks | undefined,
): ConfigField[] {
  if (quirks?.configSchemaOverride) return quirks.configSchemaOverride;
  // openai-compatible providers from models.dev have a known baseUrl
  // (provider.api). We bake that into the factory closure rather than
  // exposing it as a user-editable field, so the form stays apiKey-only.
  return DEFAULT_CONFIG_SCHEMA;
}

function defaultDescription(provider: ModelsDevProvider): string {
  const count = Object.keys(provider.models).length;
  return `${count} model${count === 1 ? "" : "s"} via ${provider.name}`;
}

/**
 * Convert a models.dev provider record into the runtime
 * `ProviderDefinition` shape consumed by the rest of the extension.
 *
 * Providers without a bundled SDK are still mapped — but their
 * `createLanguageModel` will throw at call time. Filter at the
 * registry layer if you don't want them surfaced.
 */
export function fromModelsDevProvider(
  provider: ModelsDevProvider,
  quirks: ProviderQuirks | undefined,
  options: MapOptions = {},
): ProviderDefinition {
  const includePreview = options.includePreview ?? false;
  const recommendedSet = new Set(quirks?.recommendedModels ?? []);

  const models: ModelDefinition[] = Object.values(provider.models)
    .filter((m) => shouldIncludeModel(m, includePreview))
    .map((m) => mapModel(m, recommendedSet));

  const npm = provider.npm ?? "";
  const baseUrl = provider.api;

  return {
    id: provider.id,
    name: provider.name,
    icon: quirks?.icon ?? { light: "" },
    description: quirks?.description ?? defaultDescription(provider),
    setup: "byok",
    configSchema: configSchemaFor(provider, quirks),
    models,
    createLanguageModel(config, modelId) {
      // Inject the baseUrl from models.dev for openai-compatible
      // providers so the user only fills in the apiKey.
      const merged: Record<string, string> = baseUrl
        ? { ...config, baseUrl: config.baseUrl ?? baseUrl, name: provider.id }
        : config;
      return createLanguageModelFor(npm, merged, modelId);
    },
  };
}

/** Re-exported for the registry composer. */
export { isSupportedNpm };
