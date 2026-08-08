import {
  isOffscreenContext,
  isServiceWorkerContext,
} from "@/lib/runtime/context";
import type { ModelDefinition, ProviderDefinition } from "./types";
import { WEB_LLM_MODEL_CONTEXT } from "./web-llm-model-context";

/**
 * Models mlc compiles with native function-calling support — the source of
 * truth for the `tools` capability (`functionCallingModelIds` in
 * `@mlc-ai/web-llm`). We deliberately do NOT guess tool support for other
 * models: `@browser-ai/web-llm` can prompt any model to emit JSON tool calls,
 * but reliability is unverified, so only these carry `tools` (and thus qualify
 * as the browser agent — see `agentModelGate`) until an empirical per-model
 * tool probe says otherwise.
 */
const TOOLS_MODEL_IDS = new Set<string>([
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
]);

/**
 * Human-readable name from an mlc model id, surfacing the quant variant so the
 * (many) same-model quantizations remain distinguishable in the picker.
 * "Llama-3.2-3B-Instruct-q4f16_1-MLC" -> "Llama 3.2 3B Instruct · q4f16".
 */
function deriveModelName(id: string): string {
  let base = id.replace(/-MLC$/, "");
  let quant = "";
  const m = base.match(/-(q\d+f\d+(?:_\d+)?|q0f\d+)$/i);
  if (m && m.index !== undefined) {
    quant = m[1].toLowerCase().replace(/_\d+$/, "");
    base = base.slice(0, m.index);
  }
  const label = base.replace(/-/g, " ").replace(/\s+/g, " ").trim();
  return quant ? `${label} · ${quant}` : label;
}

function deriveCapabilities(id: string): ModelDefinition["capabilities"] {
  const caps: ModelDefinition["capabilities"] = ["chat"];
  if (TOOLS_MODEL_IDS.has(id)) caps.push("tools");
  if (/vision/i.test(id)) caps.push("vision");
  if (/deepseek-r1/i.test(id) || /qwq/i.test(id)) caps.push("thinking");
  return caps;
}

/**
 * Output-token budget. mlc's configs don't publish a generation cap, so this is
 * derived rather than guessed per model: never more than a quarter of the
 * context window (so a small-window model can't reserve its whole budget for
 * output), capped at 4096 — enough for a full chat answer without starving the
 * agent's usable context. Verified to leave every model's `agentModelGate`
 * verdict unchanged versus the previous flat 1024.
 */
function deriveMaxOutputTokens(contextWindow: number): number {
  return Math.min(4_096, Math.floor(contextWindow / 4));
}

/** Approximate download size from the model's VRAM requirement (weights). */
function deriveDownloadSize(vramMB?: number): string | undefined {
  if (!vramMB) return undefined;
  return `${(vramMB / 1024).toFixed(1)} GB`;
}

/**
 * Every prebuilt WebLLM model, generated from the source-derived context table
 * (`web-llm-model-context.ts`) — the single source of truth for each model's
 * real context window (no duplication with hand-maintained values). Ordered by
 * display name.
 */
const models: ModelDefinition[] = Object.entries(WEB_LLM_MODEL_CONTEXT)
  .map(([id, ctx]): ModelDefinition => {
    const size = deriveDownloadSize(ctx.vramRequiredMB);
    return {
      id,
      name: deriveModelName(id),
      capabilities: deriveCapabilities(id),
      contextWindow: ctx.contextWindow,
      maxOutputTokens: deriveMaxOutputTokens(ctx.contextWindow),
      ...(size ? { downloadSize: size } : {}),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

export const definition: ProviderDefinition = {
  id: "web-llm",
  name: "WebLLM",
  icon: { light: "web-llm.svg" },
  description: "Run open-source models locally in your browser via WebGPU",
  setup: "web-llm",
  models,
  async createLanguageModel(config, modelId) {
    // WebLLM inference physically runs in the offscreen document
    // (`@browser-ai/web-llm` against WebGPU). Where `createLanguageModel`
    // resolves depends on which realm the caller lives in:
    //
    //   - Service worker (the agent-run host): return the bridge adapter,
    //     which opens an `offscreen-lm:*` Port and streams tokens back from
    //     offscreen. This is what makes local models work in the agent loop.
    //   - Offscreen: build the real model directly (shared engine cache in
    //     `ai.ts::getModelFromRegistry`). This is the path the bridge's
    //     offscreen handler ultimately hits.
    //   - Renderer: the agent loop is not hosted here, so there is no local
    //     path to construct; callers must go through the SW.
    if (isServiceWorkerContext()) {
      const { createLocalModelSwAdapter } = await import(
        "./__bridge__/local-model-sw-adapter"
      );
      return createLocalModelSwAdapter("web-llm", config, modelId);
    }
    if (isOffscreenContext()) {
      const { getModelFromRegistry } = await import(
        "@/entrypoints/offscreen/ai"
      );
      return await getModelFromRegistry("web-llm", config, modelId);
    }
    throw new Error(
      "WebLLM inference runs in the offscreen document; the renderer does not host local-model inference. Reach it via the service-worker agent host.",
    );
  },
};
