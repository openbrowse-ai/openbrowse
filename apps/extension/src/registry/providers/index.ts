/**
 * Provider Registry
 *
 * Composes the runtime list of providers from two sources:
 *
 * 1. **Static "special" providers** — Browser AI, Web-LLM, and the
 *    user-defined OpenAI-compatible endpoint. These are not in
 *    models.dev and have bespoke runtimes.
 *
 * 2. **Dynamic models.dev catalog** — fetched at runtime, cached, and
 *    falling back to a bundled snapshot. Provides ~80% of useful
 *    BYOK providers (Anthropic, OpenAI, Google, OpenRouter, xAI,
 *    Mistral, Groq, Together, Fireworks, …) without code changes.
 *
 * The synchronous `providers` export is initialized from the bundled
 * snapshot at module load so consumers like `<ChatInput>` can render
 * immediately. After `refreshCatalog()` completes, callers re-derive
 * via `getProviders()` (or via the `useProviders` React hook).
 */

import { definition as browserAi } from "./browser-ai";
import { definition as openaiCompatible } from "./openai-compatible";
import { definition as webLlm } from "./web-llm";
import { isSupportedNpm } from "../models-dev/bundled-sdks";
import { fromModelsDevProvider } from "../models-dev/from-models-dev";
import { getCatalog } from "../models-dev/catalog";
import { QUIRKS } from "../models-dev/quirks";
import bundledSnapshot from "../models-dev/snapshot.json";
import type { ModelsDevCatalog } from "../models-dev/types";
import type { ProviderDefinition } from "./types";

const SPECIAL_PROVIDERS: ProviderDefinition[] = [browserAi, webLlm, openaiCompatible];

function deriveProviders(catalog: ModelsDevCatalog): ProviderDefinition[] {
  const fromCatalog: ProviderDefinition[] = [];
  for (const provider of Object.values(catalog)) {
    if (!isSupportedNpm(provider.npm)) continue;
    // Hide legacy/duplicate Azure variants
    if (provider.id === "azure-cognitive-services" || provider.id === "azure-foundry") continue;
    
    const mapped = fromModelsDevProvider(provider, QUIRKS[provider.id]);
    // Skip providers that ended up with no surfacable models (e.g. all
    // models filtered as deprecated or unsupported status).
    if (mapped.models.length === 0) continue;
    fromCatalog.push(mapped);
  }
  // Sort: providers with quirks (curated) first, alphabetical inside each bucket.
  fromCatalog.sort((a, b) => {
    const aQ = QUIRKS[a.id] ? 0 : 1;
    const bQ = QUIRKS[b.id] ? 0 : 1;
    if (aQ !== bQ) return aQ - bQ;
    return a.name.localeCompare(b.name);
  });
  return [browserAi, webLlm, ...fromCatalog, openaiCompatible];
}

/**
 * Synchronous provider list initialized from the bundled snapshot.
 * Updated in place after `getProviders()` runs (mutating the array
 * keeps existing imports valid).
 */
export const providers: ProviderDefinition[] = deriveProviders(
  bundledSnapshot as unknown as ModelsDevCatalog,
);

/**
 * Async provider list using the freshest available catalog (storage
 * cache or live fetch via getCatalog). Use this in async/effect code;
 * use `useProviders()` in React render-phase code.
 */
export async function getProviders(): Promise<ProviderDefinition[]> {
  const catalog = await getCatalog();
  const next = deriveProviders(catalog);
  // Mutate in place so `providers.find(...)` stays consistent across
  // the codebase even after a live refresh.
  providers.length = 0;
  providers.push(...next);
  return next;
}

export function getProvider(id: string): ProviderDefinition | undefined {
  return providers.find((p) => p.id === id);
}

export { SPECIAL_PROVIDERS };
export type { ProviderDefinition, ConfigField, ModelDefinition } from "./types";
