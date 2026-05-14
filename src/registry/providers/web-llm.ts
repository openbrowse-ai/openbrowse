import type { ProviderDefinition } from "./types";

export const definition: ProviderDefinition = {
  id: "web-llm",
  name: "WebLLM",
  icon: { light: "web-llm.svg" },
  description: "Run open-source models locally in your browser via WebGPU",
  setup: "web-llm",
  models: [
    { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", name: "Llama 3.2 3B", capabilities: ["chat"], contextWindow: 131_072, maxOutputTokens: 4_096, downloadSize: "2.0 GB" },
    { id: "Llama-3.1-8B-Instruct-q4f16_1-MLC", name: "Llama 3.1 8B", capabilities: ["chat"], contextWindow: 131_072, maxOutputTokens: 4_096, downloadSize: "4.3 GB" },
    { id: "gemma-2-9b-it-q4f16_1-MLC", name: "Gemma 2 9B", capabilities: ["chat"], contextWindow: 8_192, maxOutputTokens: 4_096, downloadSize: "5.5 GB" },
    { id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC", name: "Hermes 3 8B", capabilities: ["chat", "tools"], contextWindow: 131_072, maxOutputTokens: 4_096, downloadSize: "4.3 GB" },
    { id: "DeepSeek-R1-Distill-Llama-8B-q4f16_1-MLC", name: "DeepSeek R1 8B", capabilities: ["chat", "thinking"], contextWindow: 131_072, maxOutputTokens: 4_096, downloadSize: "4.3 GB" },
    { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", name: "Phi 3.5 Mini", capabilities: ["chat"], contextWindow: 131_072, maxOutputTokens: 4_096, downloadSize: "2.2 GB" },
    { id: "Qwen2.5-7B-Instruct-q4f16_1-MLC", name: "Qwen 2.5 7B", capabilities: ["chat", "tools"], contextWindow: 131_072, maxOutputTokens: 4_096, downloadSize: "4.5 GB" },
    { id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC", name: "SmolLM2 1.7B", capabilities: ["chat"], contextWindow: 8_192, maxOutputTokens: 2_048, downloadSize: "1.0 GB" },
  ],
  createLanguageModel(_config, _modelId) {
    throw new Error("WebLLM models are created via web-llm runtime in offscreen document");
  },
};
