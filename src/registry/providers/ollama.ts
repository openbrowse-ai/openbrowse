import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderDefinition } from "./types";

export const definition: ProviderDefinition = {
  id: "ollama",
  name: "Ollama",
  icon: { light: "ollama.svg", dark: "ollama-dark.svg" },
  description: "Run local models via Ollama (llama, mistral, codellama, etc.)",
  setup: "byok",
  configSchema: [
    { key: "baseUrl", label: "Base URL", type: "text", required: true, default: "http://localhost:11434/v1", placeholder: "http://localhost:11434/v1", description: "Ollama server URL with /v1 suffix" },
  ],
  models: [
    { id: "llama4:scout", name: "Llama 4 Scout", capabilities: ["chat", "tools", "vision"], contextWindow: 131_072, maxOutputTokens: 8_192 },
    { id: "llama4:maverick", name: "Llama 4 Maverick", capabilities: ["chat", "tools", "vision"], contextWindow: 131_072, maxOutputTokens: 8_192 },
    { id: "llama3.3:70b", name: "Llama 3.3 70B", capabilities: ["chat", "tools"], contextWindow: 131_072, maxOutputTokens: 8_192 },
    { id: "qwen3:8b", name: "Qwen 3 8B", capabilities: ["chat", "tools"], contextWindow: 131_072, maxOutputTokens: 8_192 },
    { id: "gemma3:12b", name: "Gemma 3 12B", capabilities: ["chat", "tools", "vision"], contextWindow: 131_072, maxOutputTokens: 8_192 },
    { id: "mistral-small:24b", name: "Mistral Small 24B", capabilities: ["chat", "tools"], contextWindow: 131_072, maxOutputTokens: 8_192 },
    { id: "deepseek-r1:8b", name: "DeepSeek R1 8B", capabilities: ["chat", "thinking"], contextWindow: 131_072, maxOutputTokens: 8_192 },
  ],
  createLanguageModel(config, modelId) {
    const ollama = createOpenAI({ baseURL: config.baseUrl, apiKey: "ollama" });
    return ollama(modelId);
  },
};
