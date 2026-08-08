/**
 * Pure mapping function: ModelsDevProvider → ProviderDefinition.
 *
 * Decoupled from network/storage concerns so it's trivially unit-testable.
 * The catalog fetcher (`./catalog.ts`) and the registry composer
 * (`../providers/index.ts`) consume this.
 */

import type {
  ConfigField,
  ModelDefinition,
  ProviderDefinition,
} from "@/registry/providers/types";
import { createLanguageModelFor, isSupportedNpm } from "./bundled-sdks";
import type { ProviderQuirks } from "./quirks";
import type { ModelsDevModel, ModelsDevProvider } from "./types";

const DEFAULT_API_KEY_PLACEHOLDER = "sk-...";

/**
 * Models.dev does not expose a computer-use signal, so we flag the
 * computer-use-capable models by id. Anthropic Opus 4.5+ and Sonnet 4.5/4.6
 * (and Haiku 4.5) support the computer-use tool.
 *
 * Matches both id conventions: the direct Anthropic provider
 * (`claude-sonnet-4-6`, hyphen versions) and the Vercel AI Gateway provider
 * (`anthropic/claude-sonnet-4.6`, an `anthropic/` prefix + dot versions).
 * Kept in sync with `lib/agent/cua/model-ids.ts` (the registry deliberately
 * does not import from the agent layer to preserve dependency direction).
 */
function isComputerUseModelId(modelId: string): boolean {
  const stripped = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  const id = stripped.toLowerCase().replace(/\./g, "-");
  if (!id.includes("claude")) return false;
  return (
    /sonnet-4-(5|6)/.test(id) ||
    /haiku-4-5/.test(id) ||
    /opus-4-(5|6|7|8)/.test(id)
  );
}

function defaultConfigSchema(placeholder: string): ConfigField[] {
  return [
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      placeholder,
    },
  ];
}

/**
 * Capabilities derived from a models.dev model:
 * - `chat` always
 * - `tools` from `tool_call`
 * - `vision` from input modalities (image / pdf)
 * - `thinking` from `reasoning`
 */
function capabilitiesOf(
  model: ModelsDevModel,
): ModelDefinition["capabilities"] {
  const caps: ModelDefinition["capabilities"] = ["chat"];
  if (model.tool_call) caps.push("tools");
  const inputs = new Set(model.modalities?.input ?? []);
  if (inputs.has("image") || inputs.has("pdf")) caps.push("vision");
  if (model.reasoning) caps.push("thinking");
  if (isComputerUseModelId(model.id)) caps.push("computer-use");
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
  if (
    model.cost &&
    typeof model.cost.input === "number" &&
    typeof model.cost.output === "number"
  ) {
    def.pricing = {
      inputPer1M: model.cost.input,
      outputPer1M: model.cost.output,
    };
  }
  if (recommendedSet.has(model.id)) def.recommended = true;
  if (model.status) def.status = model.status;
  return def;
}

/**
 * Filters:
 * - Deprecated models are always hidden.
 * - Non-language models are hidden: anything whose declared output modality
 *   isn't text (image/video/audio generators, embeddings) has no place in a
 *   chat/agent model picker. This is what keeps ByteDance Seedance (video)
 *   and Seedream (image), surfaced via aggregators like Vercel AI Gateway,
 *   out of the list. Models with no declared output modality are kept —
 *   incomplete catalog metadata shouldn't hide a real LLM.
 * - Alpha/beta surface; the UI can badge them but doesn't gate them.
 */
function shouldIncludeModel(model: ModelsDevModel): boolean {
  if (model.status === "deprecated") return false;
  const output = model.modalities?.output;
  if (output && output.length > 0 && !output.includes("text")) return false;
  return true;
}

function configSchemaFor(
  _provider: ModelsDevProvider,
  quirks: ProviderQuirks | undefined,
): ConfigField[] {
  if (quirks?.configSchemaOverride) return quirks.configSchemaOverride;
  // openai-compatible providers from models.dev have a known baseUrl
  // (provider.api). We bake that into the factory closure rather than
  // exposing it as a user-editable field, so the form stays apiKey-only.
  return defaultConfigSchema(
    quirks?.apiKeyPlaceholder ?? DEFAULT_API_KEY_PLACEHOLDER,
  );
}

function defaultDescription(provider: ModelsDevProvider): string {
  const count = Object.keys(provider.models).length;
  return `${count} model${count === 1 ? "" : "s"} via ${provider.name}`;
}

function substituteUrlVars(
  template: string,
  config: Record<string, string>,
  envVarMap?: Record<string, string>,
): string {
  return template.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const configKey = envVarMap?.[varName] ?? varName;
    const value = config[configKey];
    if (value === undefined || value === "") {
      throw new Error(
        `Missing required configuration: ${configKey} (for ${varName})`,
      );
    }
    return value;
  });
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
): ProviderDefinition {
  const recommendedSet = new Set(quirks?.recommendedModels ?? []);

  const models: ModelDefinition[] = [];
  const modelOverrides = new Map<string, { npm?: string; api?: string }>();

  for (const m of Object.values(provider.models)) {
    if (shouldIncludeModel(m)) {
      models.push(mapModel(m, recommendedSet));
      if (m.provider?.npm || m.provider?.api) {
        modelOverrides.set(m.id, { npm: m.provider.npm, api: m.provider.api });
      }
    }
  }

  const defaultNpm = provider.npm ?? "";
  const defaultBaseUrl = provider.api;

  return {
    id: provider.id,
    name: provider.name,
    icon: quirks?.icon ?? { light: "" },
    description: quirks?.description ?? defaultDescription(provider),
    setup: "byok",
    configSchema: configSchemaFor(provider, quirks),
    models,
    createLanguageModel(config, modelId) {
      const override = modelOverrides.get(modelId);
      const npm = override?.npm ?? defaultNpm;
      let baseUrl = override?.api ?? defaultBaseUrl;

      if (baseUrl) {
        baseUrl = substituteUrlVars(baseUrl, config, quirks?.envVarMap);
      }

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
