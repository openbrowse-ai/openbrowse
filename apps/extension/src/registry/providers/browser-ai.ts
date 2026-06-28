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
    // Same situation as web-llm: Chrome's built-in AI runs in the
    // offscreen document; non-agent consumers message offscreen directly,
    // and the agent loop has never supported local models (no offscreen→
    // host streaming bridge exists yet). See web-llm.ts for context.
    throw new Error("Browser AI models are created via chrome.ai API in offscreen document");
  },
};
