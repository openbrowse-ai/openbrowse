/**
 * Per-provider overrides that can't live in models.dev's api.json.
 *
 * This is the only file you need to touch when a provider needs
 * special-case configuration: a custom icon, a non-default config
 * form, hand-curated "Recommended" model badges, etc.
 *
 * Providers without an entry here use sensible defaults from
 * `from-models-dev.ts`.
 */

import type { ConfigField } from "@/registry/providers/types";

export interface ProviderQuirks {
  /** Icon filenames in `registry/providers/icons/` (light + optional dark variant). */
  icon?: { light: string; dark?: string };

  /** Override the default config form (`apiKey` only). */
  configSchemaOverride?: ConfigField[];

  /**
   * Placeholder hint shown in the API key input — e.g. `sk-ant-...`
   * for Anthropic. Falls back to a generic `sk-...`.
   */
  apiKeyPlaceholder?: string;

  /** One-line description shown in the provider list (otherwise derived from models.dev `doc`). */
  description?: string;

  /**
   * Model ids to flag with a "Recommended" badge in the picker.
   * Falsy/empty means no badge.
   */
  recommendedModels?: string[];

  /**
   * Maps models.dev `${ENV_VAR}` names to extension config keys.
   * For example: { AZURE_RESOURCE_NAME: "resourceName" }
   */
  envVarMap?: Record<string, string>;
}

/**
 * Quirks keyed by models.dev provider id. The id matches what models.dev
 * itself uses (e.g. "anthropic", "openai", "google", "openrouter").
 */
export const QUIRKS: Record<string, ProviderQuirks> = {
  anthropic: {
    icon: { light: "anthropic.svg" },
    description:
      "Claude Opus, Sonnet, and Haiku models with extended thinking",
    apiKeyPlaceholder: "sk-ant-...",
    recommendedModels: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  },
  openai: {
    icon: { light: "openai.svg" },
    description: "GPT-5 series, o-series reasoning, and GPT-4.1 models",
    apiKeyPlaceholder: "sk-proj-...",
    recommendedModels: ["gpt-5.5", "o4-mini", "gpt-5.5-pro"],
  },
  google: {
    icon: { light: "google.svg" },
    description: "Gemini 3.x and 2.5 multimodal models",
    apiKeyPlaceholder: "AIza...",
    recommendedModels: ["gemini-3.1-pro-preview", "gemini-3.5-flash"],
  },
  xai: {
    icon: { light: "xai.svg" },
    description: "Grok models from xAI",
    apiKeyPlaceholder: "xai-...",
  },
  mistral: {
    icon: { light: "mistral.svg" },
    description: "Mistral and Codestral models from Mistral AI",
    apiKeyPlaceholder: "Mistral API key",
  },
  openrouter: {
    icon: { light: "openrouter.svg" },
    description:
      "Single-key access to hundreds of models across providers via OpenRouter",
    apiKeyPlaceholder: "sk-or-v1-...",
  },
  groq: {
    apiKeyPlaceholder: "gsk_...",
  },
  cerebras: {
    apiKeyPlaceholder: "csk-...",
  },
  perplexity: {
    apiKeyPlaceholder: "pplx-...",
  },
  togetherai: {
    apiKeyPlaceholder: "Together API key",
  },
  fireworks: {
    apiKeyPlaceholder: "fw-...",
  },
  "fireworks-ai": {
    apiKeyPlaceholder: "fw-...",
  },
  deepseek: {
    apiKeyPlaceholder: "sk-...",
    description: "DeepSeek V3 and DeepSeek-R1 reasoning models",
  },
  "github-models": {
    apiKeyPlaceholder: "ghp_...",
    description: "Free-tier model access via GitHub Models",
  },
  huggingface: {
    apiKeyPlaceholder: "hf_...",
    description: "Open-weights and Inference Providers via Hugging Face",
  },
  azure: {
    icon: { light: "azure.svg" },
    description: "Azure AI Foundry — OpenAI, Anthropic, and Llama models on your Azure tenant",
    configSchemaOverride: [
      {
        key: "resourceName",
        label: "Resource Name",
        type: "text",
        required: true,
        placeholder: "my-resource",
        description: "Your Azure OpenAI or Foundry resource name",
      },
      {
        key: "apiKey",
        label: "API Key",
        type: "password",
        required: true,
      },
      {
        key: "apiVersion",
        label: "API Version",
        type: "text",
        required: false,
        placeholder: "2024-10-21",
        description: "Leave blank for SDK default",
      },
    ],
    recommendedModels: ["gpt-5.5", "claude-opus-4-7", "o4-mini"],
    envVarMap: {
      AZURE_RESOURCE_NAME: "resourceName",
    },
  },
  vercel: {
    icon: { light: "vercel.svg" },
    description: "Single key access to OpenAI, Anthropic, Bedrock, Vertex, Mistral, Llama, and more — billed through Vercel",
    apiKeyPlaceholder: "Vercel AI Gateway API key",
    recommendedModels: [
      "openai/gpt-5.5",
      "anthropic/claude-opus-4.7",
      "google/gemini-3.1-pro-preview",
      "openai/o4-mini",
      "deepseek/deepseek-v4-pro",
    ],
  },
};

/** Convenience: returns the quirks entry for a provider id, or undefined. */
export function getQuirks(providerId: string): ProviderQuirks | undefined {
  return QUIRKS[providerId];
}
