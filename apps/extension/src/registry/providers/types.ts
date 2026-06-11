/**
 * Provider Registry Types
 *
 * A provider represents an LLM backend available in OpenBrowse.
 * Each provider defines its configuration schema (API keys, base URLs),
 * available models with their capabilities/pricing, and a factory
 * function to instantiate AI SDK language models.
 */

import type { LanguageModel } from "ai";

/** A field in the provider's configuration form shown in settings. */
export interface ConfigField {
  /** Storage key used in the config record (e.g. "apiKey", "baseUrl"). */
  key: string;

  /** Human-readable label for the form input. */
  label: string;

  /** Input type — determines the form control rendered. */
  type: "text" | "password" | "select" | "number";

  /** Whether the field must be filled before the provider can be used. */
  required: boolean;

  /** Placeholder text shown when the input is empty. */
  placeholder?: string;

  /** Helper text shown below the input. */
  description?: string;

  /** Options for `type: "select"` fields. */
  options?: { label: string; value: string }[];

  /** Default value pre-filled in the input. */
  default?: string;
}

/** Qualitative intelligence tier — used for model comparison UI. */
export type Intelligence = "high" | "medium" | "low";

/** Qualitative speed tier — used for model comparison UI. */
export type Speed = "fast" | "medium" | "slow";

export interface ModelPricing {
  /** Cost per 1M input tokens in USD. */
  inputPer1M: number;
  /** Cost per 1M output tokens in USD. */
  outputPer1M: number;
}

export interface ModelDefinition {
  /** Model identifier passed to the provider SDK (e.g. "claude-sonnet-4-6"). */
  id: string;

  /** Display name shown in the model picker (e.g. "Claude Sonnet 4.6"). */
  name: string;

  /** One-line description of the model's strengths. */
  description?: string;

  /**
   * Capabilities this model supports:
   * - `"chat"` — basic text generation
   * - `"tools"` — function/tool calling
   * - `"vision"` — image input
   * - `"thinking"` — extended thinking / chain-of-thought
   */
  capabilities: ("chat" | "tools" | "vision" | "thinking" | "computer-use")[];

  /**
   * Qualitative intelligence rating for comparison UI.
   * @deprecated models.dev doesn't expose this signal; surfaces only on
   * legacy hand-curated providers. New providers will leave this unset.
   */
  intelligence?: Intelligence;

  /**
   * Qualitative speed rating for comparison UI.
   * @deprecated see `intelligence`.
   */
  speed?: Speed;

  /** Whether this model should show a "Recommended" badge in the picker. */
  recommended?: boolean;

  /** Maximum input context window in tokens. */
  contextWindow?: number;

  /** Maximum output tokens the model can generate. */
  maxOutputTokens?: number;

  /** Pricing per 1M tokens (omit for free/local models). */
  pricing?: ModelPricing;

  /** Approximate download size for local models (e.g. "4.3 GB"). */
  downloadSize?: string;

  /**
   * Lifecycle status from models.dev (deprecated/alpha/beta). Used by the
   * UI to gate preview models behind a settings toggle.
   */
  status?: "alpha" | "beta" | "deprecated";
}

export interface ProviderDefinition {
  /**
   * Unique identifier. Used as the storage key and to resolve icons.
   * Must be lowercase, alphanumeric + hyphens (e.g. "openai", "openai-compatible").
   */
  id: string;

  /** Human-readable display name (e.g. "OpenAI"). */
  name: string;

  /**
   * Icon filenames relative to `src/registry/providers/icons/`.
   * The `dark` variant is optional — only needed if the light icon
   * doesn't work well on dark backgrounds.
   */
  icon: { light: string; dark?: string };

  /** One-line description shown in the provider list. */
  description: string;

  /**
   * Setup mode determining how the provider is configured:
   * - `"byok"` — user brings their own API key
   * - `"browser-ai"` — uses Chrome's built-in AI (no config needed)
   * - `"web-llm"` — downloads and runs models locally via WebGPU
   */
  setup: "byok" | "browser-ai" | "web-llm";

  /** Configuration fields shown in the settings form. */
  configSchema?: ConfigField[];

  /** Available models for this provider. */
  models: ModelDefinition[];

  /**
   * Factory function that creates an AI SDK LanguageModel instance.
   * Called when the user selects this provider + model for a chat.
   *
   * Returns a Promise so providers can lazy-load their SDK adapter
   * via dynamic import — keeps the boot bundle small.
   *
   * @param config - User-provided config values (keyed by ConfigField.key)
   * @param modelId - The selected ModelDefinition.id
   */
  createLanguageModel: (
    config: Record<string, string>,
    modelId: string,
  ) => LanguageModel | Promise<LanguageModel>;
}
