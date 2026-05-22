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

  /** One-line description shown in the provider list (otherwise derived from models.dev `doc`). */
  description?: string;

  /**
   * Model ids to flag with a "Recommended" badge in the picker.
   * Falsy/empty means no badge.
   */
  recommendedModels?: string[];
}

/**
 * Quirks keyed by models.dev provider id. The id matches what models.dev
 * itself uses (e.g. "anthropic", "openai", "google", "openrouter").
 */
export const QUIRKS: Record<string, ProviderQuirks> = {
  anthropic: {
    icon: { light: "anthropic.svg", dark: "anthropic-dark.svg" },
    description:
      "Claude Opus, Sonnet, and Haiku models with extended thinking",
    recommendedModels: [
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  },
  openai: {
    icon: { light: "openai.svg", dark: "openai-dark.svg" },
    description: "GPT-5 series, o-series reasoning, and GPT-4.1 models",
    recommendedModels: ["gpt-5.5", "gpt-5-mini"],
  },
  google: {
    icon: { light: "google.svg" },
    description: "Gemini 3.x and 2.5 multimodal models",
    recommendedModels: ["gemini-flash-latest", "gemini-2.5-pro"],
  },
  xai: {
    icon: { light: "xai.svg", dark: "xai-dark.svg" },
    description: "Grok models from xAI",
  },
  mistral: {
    icon: { light: "mistral.svg" },
    description: "Mistral and Codestral models from Mistral AI",
  },
  openrouter: {
    icon: { light: "openrouter.svg", dark: "openrouter-dark.svg" },
    description:
      "Single-key access to hundreds of models across providers via OpenRouter",
  },
};

/** Convenience: returns the quirks entry for a provider id, or undefined. */
export function getQuirks(providerId: string): ProviderQuirks | undefined {
  return QUIRKS[providerId];
}
