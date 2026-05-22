/**
 * Static map of AI SDK packages we ship with the extension.
 *
 * The keys match the `npm` field on each provider in models.dev/api.json.
 * Providers whose `npm` value isn't in this map are filtered out of the
 * runtime registry (we have no way to talk to them).
 *
 * To add a new provider, add the npm package as a dependency in
 * package.json, register a factory here, and (optionally) add quirks
 * such as icons or extra headers in `./quirks.ts`.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/** A factory turning user-provided config + a model id into an AI SDK LanguageModel. */
export type SdkFactory = (
  config: Record<string, string>,
  modelId: string,
) => LanguageModel;

/** Maps the `npm` field from models.dev to a bundled SDK factory. */
export const BUNDLED_PROVIDERS: Record<string, SdkFactory> = {
  "@ai-sdk/anthropic": (config, modelId) => {
    const anthropic = createAnthropic({
      apiKey: config.apiKey,
      // Required for direct browser calls; the extension is a first-party caller.
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
    });
    return anthropic(modelId);
  },
  "@ai-sdk/openai": (config, modelId) => {
    const openai = createOpenAI({ apiKey: config.apiKey });
    return openai(modelId);
  },
  "@ai-sdk/google": (config, modelId) => {
    const google = createGoogleGenerativeAI({ apiKey: config.apiKey });
    return google(modelId);
  },
  "@ai-sdk/openai-compatible": (config, modelId) => {
    // baseUrl + name come from the provider definition; user supplies apiKey.
    const provider = createOpenAICompatible({
      name: config.name ?? "openai-compatible",
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    return provider(modelId);
  },
  "@ai-sdk/xai": (config, modelId) => {
    const xai = createXai({ apiKey: config.apiKey });
    return xai(modelId);
  },
  "@ai-sdk/mistral": (config, modelId) => {
    const mistral = createMistral({ apiKey: config.apiKey });
    return mistral(modelId);
  },
  "@openrouter/ai-sdk-provider": (config, modelId) => {
    const openrouter = createOpenRouter({
      apiKey: config.apiKey,
      headers: {
        "HTTP-Referer": "https://openbrowse.dev",
        "X-Title": "OpenBrowse",
      },
    });
    return openrouter(modelId);
  },
};

/** Returns true if we have a bundled SDK for the given npm package. */
export function isSupportedNpm(npm: string | undefined): boolean {
  return typeof npm === "string" && npm in BUNDLED_PROVIDERS;
}

/**
 * Instantiates a LanguageModel for the given npm package + config + model id.
 * Throws a typed error if the npm package isn't bundled.
 */
export function createLanguageModelFor(
  npm: string,
  config: Record<string, string>,
  modelId: string,
): LanguageModel {
  const factory = BUNDLED_PROVIDERS[npm];
  if (!factory) {
    throw new Error(
      `No bundled SDK for npm package "${npm}". This provider was unexpectedly surfaced; please file a bug.`,
    );
  }
  return factory(config, modelId);
}
