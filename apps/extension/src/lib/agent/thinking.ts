/**
 * Shared logic for translating the UI's `ThinkingConfig` into the
 * provider-specific `providerOptions` shape the Vercel AI SDK forwards to a
 * model.
 *
 * Two problems this module solves:
 *
 *  1. **Gateway routing.** A model can be reached either directly (registry
 *     provider id is the vendor itself: `anthropic` / `google` / `openai`) or
 *     through the Vercel AI Gateway (provider id `vercel`, model id prefixed
 *     with the vendor, e.g. `google/gemini-3.1-pro-preview`). The earlier
 *     implementation dispatched only on `provider.id`, so gateway-routed models
 *     silently received NO thinking options. `resolveThinkingVendor` collapses
 *     both forms to a single vendor.
 *
 *  2. **Gemini 2.5 vs Gemini 3.** Gemini 2.5 models take a numeric
 *     `thinkingBudget`; Gemini 3 models take a `thinkingLevel`
 *     (`minimal | low | medium | high`) and ignore `thinkingBudget`. See the
 *     AI SDK Google provider docs. `includeThoughts: true` is always set so the
 *     reasoning summary streams back and renders in the `<Reasoning>` UI.
 */

import { normalizeModelId } from "./cua/model-ids";
import type { ThinkingConfig } from "../types";

export type ThinkingVendor = "anthropic" | "google" | "openai";

/**
 * Map a registry provider id + model id to the underlying model vendor, or
 * `null` when the provider/model isn't one we know how to send thinking
 * options to.
 *
 *  - Direct providers (`anthropic` / `google` / `openai`) map to themselves.
 *  - The Vercel AI Gateway (`vercel`) is transparent: the vendor is encoded as
 *    the model-id prefix (`anthropic/…`, `google/…`, `openai/…`).
 */
export function resolveThinkingVendor(
  providerId: string,
  modelId: string,
): ThinkingVendor | null {
  if (
    providerId === "anthropic" ||
    providerId === "google" ||
    providerId === "openai"
  ) {
    return providerId;
  }

  if (providerId === "vercel") {
    const slash = modelId.indexOf("/");
    const prefix = (slash >= 0 ? modelId.slice(0, slash) : "").toLowerCase();
    if (prefix === "anthropic" || prefix === "google" || prefix === "openai") {
      return prefix;
    }
  }

  return null;
}

/**
 * True when the (normalized) model id is a Gemini 3 generation model, which
 * uses `thinkingLevel` rather than `thinkingBudget`. Matches both direct
 * (`gemini-3.1-pro-preview`) and gateway (`google/gemini-3.1-pro-preview`)
 * forms via `normalizeModelId` (lowercases, strips the vendor prefix, and
 * treats `.`/`-` as the same separator → `gemini-3-1-pro-preview`).
 */
export function isGemini3Model(modelId: string): boolean {
  return /(^|[^0-9])gemini-3/.test(normalizeModelId(modelId));
}

/**
 * True when the (normalized) model id is a Gemini "flash" variant, which
 * supports the extra `minimal` thinking level (Gemini 3) and a wider thinking
 * budget range (Gemini 2.5).
 */
export function isGeminiFlashModel(modelId: string): boolean {
  const id = normalizeModelId(modelId);
  return id.includes("gemini") && id.includes("flash");
}

const VALID_GEMINI3_LEVELS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
]);

/**
 * Build the AI SDK `providerOptions` for a thinking-enabled request, keyed by
 * the resolved vendor. Returns `undefined` when the vendor is unknown or the
 * config shape doesn't apply to the vendor.
 *
 * The returned shape is always vendor-keyed (`{ google: … }`, `{ anthropic: …
 * }`, `{ openai: … }`), which is exactly what the gateway forwards — so the
 * same builder serves both direct and gateway-routed models.
 */
export function buildThinkingProviderOptions(
  providerId: string,
  modelId: string,
  config: ThinkingConfig,
): Record<string, unknown> | undefined {
  const vendor = resolveThinkingVendor(providerId, modelId);
  if (!vendor) return undefined;

  if (vendor === "google") {
    if (isGemini3Model(modelId)) {
      // Gemini 3: thinkingLevel. Derive from an effort-style config; fall back
      // to "medium" for legacy budget-style configs persisted before Gemini 3.
      const level =
        config.type === "effort" && VALID_GEMINI3_LEVELS.has(config.level)
          ? config.level
          : "medium";
      return {
        google: {
          thinkingConfig: { thinkingLevel: level, includeThoughts: true },
        },
      };
    }
    // Gemini 2.5: thinkingBudget. Fall back to a sane default when an
    // effort-style config is somehow paired with a 2.5 model.
    const budget = config.type === "budget" ? config.tokens : 8192;
    return {
      google: {
        thinkingConfig: { thinkingBudget: budget, includeThoughts: true },
      },
    };
  }

  if (vendor === "anthropic") {
    if (config.type === "effort") {
      return {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized" },
          effort: config.level,
        },
      };
    }
    return {
      anthropic: { thinking: { type: "adaptive", display: "summarized" } },
    };
  }

  // openai
  if (config.type === "effort") {
    return { openai: { reasoning: { effort: config.level } } };
  }
  return undefined;
}
