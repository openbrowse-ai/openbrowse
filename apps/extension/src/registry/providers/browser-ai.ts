import type { ProviderDefinition } from "./types";

export const definition: ProviderDefinition = {
  id: "browser-ai",
  name: "Built-in AI",
  icon: { light: "browser-ai.svg" },
  description: "Chrome's built-in Gemini Nano — runs locally, no API key needed",
  setup: "browser-ai",
  models: [
    { id: "gemini-nano", name: "Gemini Nano", capabilities: ["chat"], contextWindow: 4_096, maxOutputTokens: 2_048 },
  ],
  createLanguageModel(_config, _modelId) {
    throw new Error("Browser AI models are created via chrome.ai API in offscreen document");
  },
};
