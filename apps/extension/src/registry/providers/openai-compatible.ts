import type { ProviderDefinition } from "./types";

export const definition: ProviderDefinition = {
  id: "openai-compatible",
  name: "OpenAI Compatible",
  icon: { light: "openai-compatible.svg" },
  description: "Any provider with an OpenAI-compatible API (Groq, Together, Fireworks, etc.)",
  setup: "byok",
  configSchema: [
    { key: "baseUrl", label: "Base URL", type: "text", required: true, placeholder: "https://api.example.com/v1", description: "The API base URL (must end in /v1)" },
    { key: "apiKey", label: "API Key", type: "password", required: true, placeholder: "your-api-key" },
    { key: "modelId", label: "Model ID", type: "text", required: true, placeholder: "model-name", description: "The model identifier to use" },
  ],
  models: [],
  async createLanguageModel(config, modelId) {
    // Lazy-load the SDK so the openai-compatible adapter only ships
    // in a chunk that's downloaded when the user actually uses it.
    const { createOpenAI } = await import("@ai-sdk/openai");
    const provider = createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey });
    return provider(modelId || config.modelId);
  },
};
