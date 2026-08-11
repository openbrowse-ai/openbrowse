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

/**
 * Family + version matcher for Claude ids, tolerant of both id conventions
 * (`claude-opus-4-7`, `anthropic/claude-opus-4.7`) and of a trailing date
 * stamp (`claude-opus-4-5-20251101`). Group 1 is the family (`opus`,
 * `sonnet`, `haiku`, ...), 2 the major version, 3 the optional minor.
 *
 * Legacy ids that put the version first (`claude-3-opus-20240229`) don't
 * match, which is what we want — they long predate adaptive thinking.
 */
const CLAUDE_FAMILY_VERSION = /claude-([a-z]+)-(\d+)(?:-(\d+))?/;

/**
 * True when the model belongs to Anthropic's adaptive-thinking generation:
 * Sonnet 4.6, Opus 4.6, and everything newer (>= 4.6).
 *
 * These take `thinking: { type: "adaptive" }`; older models take
 * `{ type: "enabled", budgetTokens }`. The distinction is the whole reason
 * `isThinkingAlwaysOn` exists — an adaptive model's thinking isn't optional,
 * only its visibility is.
 */
export function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
  const match = CLAUDE_FAMILY_VERSION.exec(normalizeModelId(modelId));
  if (!match) return false;
  const major = Number(match[2]);
  if (!Number.isInteger(major)) return false;
  const minor = match[3] != null ? Number(match[3]) : 0;
  return major > 4 || (major === 4 && minor >= 6);
}

/**
 * Whether thinking must be treated as always-on for this provider/model,
 * regardless of the composer's Thinking toggle.
 *
 * True only for Anthropic's adaptive generation. Switching the toggle off
 * there never stopped the model thinking — it only dropped
 * `display: "summarized"` from the request, so Anthropic fell back to its
 * `display: "omitted"` default and streamed thinking blocks whose text is
 * empty. The tokens were spent either way; all the toggle bought was a
 * transcript full of blank `<Reasoning>` blocks. So force it on and let the
 * user see what they paid for.
 */
export function isThinkingAlwaysOn(
  providerId: string,
  modelId: string,
): boolean {
  return (
    resolveThinkingVendor(providerId, modelId) === "anthropic" &&
    isAnthropicAdaptiveThinkingModel(modelId)
  );
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
 * `config` is optional so the always-on path (`resolveThinkingProviderOptions`
 * with the toggle off) can request thinking without inventing an effort level
 * or budget the user never chose — each vendor branch falls back to its own
 * default, or omits the knob entirely.
 *
 * The returned shape is always vendor-keyed (`{ google: … }`, `{ anthropic: …
 * }`, `{ openai: … }`), which is exactly what the gateway forwards — so the
 * same builder serves both direct and gateway-routed models.
 */
export function buildThinkingProviderOptions(
  providerId: string,
  modelId: string,
  config?: ThinkingConfig,
): Record<string, unknown> | undefined {
  const vendor = resolveThinkingVendor(providerId, modelId);
  if (!vendor) return undefined;

  if (vendor === "google") {
    if (isGemini3Model(modelId)) {
      // Gemini 3: thinkingLevel. Derive from an effort-style config; fall back
      // to "medium" for legacy budget-style configs persisted before Gemini 3.
      const level =
        config?.type === "effort" && VALID_GEMINI3_LEVELS.has(config.level)
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
    const budget = config?.type === "budget" ? config.tokens : 8192;
    return {
      google: {
        thinkingConfig: { thinkingBudget: budget, includeThoughts: true },
      },
    };
  }

  if (vendor === "anthropic") {
    if (config?.type === "effort") {
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
  if (config?.type === "effort") {
    return { openai: { reasoning: { effort: config.level } } };
  }
  return undefined;
}

/**
 * The single entry point transports use to decide what thinking options a run
 * should carry. Wraps `buildThinkingProviderOptions` with the always-on rule.
 *
 * Thinking is requested when EITHER the user enabled it, OR the model thinks
 * unconditionally (`isThinkingAlwaysOn`). Living here rather than at the call
 * sites means every path — side panel, SW host, headless, MCP task runner —
 * gets the same answer for the same model.
 */
export function resolveThinkingProviderOptions(
  providerId: string,
  modelId: string,
  thinking?: { enabled: boolean; config?: ThinkingConfig },
): Record<string, unknown> | undefined {
  const on =
    thinking?.enabled === true || isThinkingAlwaysOn(providerId, modelId);
  if (!on) return undefined;
  return buildThinkingProviderOptions(providerId, modelId, thinking?.config);
}
