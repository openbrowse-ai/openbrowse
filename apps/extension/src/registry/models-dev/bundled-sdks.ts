/**
 * Lazy-loaded map of AI SDK packages we ship with the extension.
 *
 * The keys match the `npm` field on each provider in models.dev/api.json.
 * Providers whose `npm` value isn't in this map are filtered out of
 * the runtime registry.
 *
 * Each entry returns a Promise so the underlying SDK is loaded as a
 * separate Vite chunk on first use, not as part of the background
 * service-worker boot bundle. Repeated calls reuse the resolved
 * import via the runtime's built-in module cache.
 *
 * To add a new provider, add the npm package as a dependency in
 * package.json, register a factory here, and (optionally) add quirks
 * such as icons or extra headers in `./quirks.ts`.
 */

import type { LanguageModel } from "ai";

/** Async factory: user config + model id → AI SDK LanguageModel. */
export type SdkFactory = (
  config: Record<string, string>,
  modelId: string,
) => Promise<LanguageModel>;

/** Maps the `npm` field from models.dev to a bundled SDK factory. */
export const BUNDLED_PROVIDERS: Record<string, SdkFactory> = {
  "@ai-sdk/anthropic": async (config, modelId) => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      // Required for direct browser calls; the extension is a first-party caller.
      headers: { "anthropic-dangerous-direct-browser-access": "true" },
    });
    return anthropic(modelId);
  },
  "@ai-sdk/openai": async (config, modelId) => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });
    return openai(modelId);
  },
  "@ai-sdk/google": async (config, modelId) => {
    const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
    const google = createGoogleGenerativeAI({ apiKey: config.apiKey });
    return google(modelId);
  },
  "@ai-sdk/openai-compatible": async (config, modelId) => {
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
    const provider = createOpenAICompatible({
      name: config.name ?? "openai-compatible",
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    return provider(modelId);
  },
  "@ai-sdk/xai": async (config, modelId) => {
    const { createXai } = await import("@ai-sdk/xai");
    const xai = createXai({ apiKey: config.apiKey });
    return xai(modelId);
  },
  "@ai-sdk/mistral": async (config, modelId) => {
    const { createMistral } = await import("@ai-sdk/mistral");
    const mistral = createMistral({ apiKey: config.apiKey });
    return mistral(modelId);
  },
  "@openrouter/ai-sdk-provider": async (config, modelId) => {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    const openrouter = createOpenRouter({
      apiKey: config.apiKey,
      headers: {
        "HTTP-Referer": "https://openbrowse.dev",
        "X-Title": "OpenBrowse",
      },
    });
    return openrouter(modelId);
  },
  "@ai-sdk/groq": async (config, modelId) => {
    const { createGroq } = await import("@ai-sdk/groq");
    const groq = createGroq({ apiKey: config.apiKey });
    return groq(modelId);
  },
  "@ai-sdk/cerebras": async (config, modelId) => {
    const { createCerebras } = await import("@ai-sdk/cerebras");
    const cerebras = createCerebras({ apiKey: config.apiKey });
    return cerebras(modelId);
  },
  "@ai-sdk/perplexity": async (config, modelId) => {
    const { createPerplexity } = await import("@ai-sdk/perplexity");
    const perplexity = createPerplexity({ apiKey: config.apiKey });
    return perplexity(modelId);
  },
  "@ai-sdk/togetherai": async (config, modelId) => {
    const { createTogetherAI } = await import("@ai-sdk/togetherai");
    const together = createTogetherAI({ apiKey: config.apiKey });
    return together(modelId);
  },
  "@ai-sdk/azure": async (config, modelId) => {
    const { createAzure } = await import("@ai-sdk/azure");
    const azure = createAzure({
      resourceName: config.resourceName,
      apiKey: config.apiKey,
      // Pass apiVersion if provided, otherwise the sdk default will be used
      ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    });
    return azure(modelId);
  },
  "@ai-sdk/gateway": async (config, modelId) => {
    const { createGateway } = await import("@ai-sdk/gateway");
    const gateway = createGateway({ apiKey: config.apiKey });
    return gateway(modelId);
  },
};

/** Returns true if we have a bundled SDK for the given npm package. */
export function isSupportedNpm(npm: string | undefined): boolean {
  return typeof npm === "string" && npm in BUNDLED_PROVIDERS;
}

/**
 * Instantiates a LanguageModel for the given npm package + config + model id.
 * Throws (rejects) if the npm package isn't bundled.
 */
export async function createLanguageModelFor(
  npm: string,
  config: Record<string, string>,
  modelId: string,
): Promise<LanguageModel> {
  const factory = BUNDLED_PROVIDERS[npm];
  if (!factory) {
    throw new Error(
      `No bundled SDK for npm package "${npm}". This provider was unexpectedly surfaced; please file a bug.`,
    );
  }
  return factory(config, modelId);
}
