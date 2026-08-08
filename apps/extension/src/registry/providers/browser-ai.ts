import {
  isOffscreenContext,
  isServiceWorkerContext,
} from "@/lib/runtime/context";
import type { ProviderDefinition } from "./types";

export const definition: ProviderDefinition = {
  id: "browser-ai",
  name: "Built-in AI",
  icon: { light: "browser-ai.svg" },
  description:
    "Chrome's built-in Gemini Nano — runs locally, no API key needed",
  setup: "browser-ai",
  models: [
    {
      id: "gemini-nano",
      name: "Gemini Nano",
      capabilities: ["chat"],
      contextWindow: 4_096,
      maxOutputTokens: 2_048,
    },
  ],
  async createLanguageModel(config, modelId) {
    // Same realm split as web-llm: Chrome's built-in AI (`chrome.ai`) runs
    // only in the offscreen document. In the service worker (agent-run host)
    // we return the bridge adapter that streams from offscreen; in offscreen
    // we build the real model directly; in a renderer there is no local path.
    // See `web-llm.ts` and `registry/providers/__bridge__` for details.
    if (isServiceWorkerContext()) {
      const { createLocalModelSwAdapter } = await import(
        "./__bridge__/local-model-sw-adapter"
      );
      return createLocalModelSwAdapter("browser-ai", config, modelId);
    }
    if (isOffscreenContext()) {
      const { getModelFromRegistry } = await import(
        "@/entrypoints/offscreen/ai"
      );
      return await getModelFromRegistry("browser-ai", config, modelId);
    }
    throw new Error(
      "Browser AI (Gemini Nano) runs in the offscreen document; the renderer does not host local-model inference. Reach it via the service-worker agent host.",
    );
  },
};
